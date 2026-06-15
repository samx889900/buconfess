import { NextRequest, NextResponse } from 'next/server';
import { getAdminFromRequest } from '@/lib/auth';
import { getGoogleSheet } from '@/lib/googleSheets';
import { splitTextIntoParts } from '@/lib/imageGenerator';

const GRAPH_API_VERSION = 'v20.0';
const DEFAULT_APP_URL = 'https://buconfess-production.up.railway.app';

/** Maximum time (ms) to wait for a container to finish processing. */
const CONTAINER_POLL_TIMEOUT_MS = 90_000;
/** Interval (ms) between container status checks. */
const CONTAINER_POLL_INTERVAL_MS = 3_000;

type GraphResponse = {
  id?: string;
  permalink?: string;
  status_code?: string;
  error?: {
    message?: string;
    code?: number;
    error_subcode?: number;
    type?: string;
    fbtrace_id?: string;
  };
};

function normalizeHandle(handle: string) {
  return handle.startsWith('@') ? handle : `@${handle}`;
}

function getBaseUrl() {
  return (process.env.NEXT_PUBLIC_APP_URL || DEFAULT_APP_URL).replace(/\/$/, '');
}

function toAbsoluteUrl(baseUrl: string, value: string) {
  if (value.startsWith('http://') || value.startsWith('https://')) {
    return value;
  }

  return baseUrl + (value.startsWith('/') ? value : '/' + value);
}

function buildCaption(confessionNumber: number | null, handle: string) {
  const prefix = (process.env.IG_CAPTION_PREFIX || 'BU Confession').trim();
  return [
    `${prefix} #${confessionNumber ?? 'Draft'}`,
    'DM or visit the link in bio to submit yours!',
    normalizeHandle(handle),
  ].join('\n\n');
}

async function graphPost(
  path: string,
  body: Record<string, unknown>,
  accessToken: string
) {
  const response = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, access_token: accessToken }),
  });

  const data = (await response.json()) as GraphResponse;
  if (!response.ok || data.error) {
    console.error('Instagram Graph API failure', {
      path,
      status: response.status,
      error: data.error ?? data,
      body,
    });
    throw new Error(
      data.error?.message || `Graph API request failed with status ${response.status}`
    );
  }

  return data;
}

async function graphGet(path: string, accessToken: string) {
  const separator = path.includes('?') ? '&' : '?';
  const response = await fetch(
    `https://graph.facebook.com/${GRAPH_API_VERSION}/${path}${separator}access_token=${encodeURIComponent(accessToken)}`,
    { method: 'GET' }
  );

  const data = (await response.json()) as GraphResponse;
  if (!response.ok || data.error) {
    console.error('Instagram Graph API failure', {
      path,
      status: response.status,
      error: data.error ?? data,
    });
    throw new Error(
      data.error?.message || `Graph API request failed with status ${response.status}`
    );
  }

  return data;
}

/**
 * Polls the container status until it reaches FINISHED or errors out.
 * Instagram's container creation is asynchronous — you MUST wait for
 * the container to finish processing before calling media_publish.
 */
async function waitForContainerReady(containerId: string, accessToken: string): Promise<void> {
  const startTime = Date.now();

  while (Date.now() - startTime < CONTAINER_POLL_TIMEOUT_MS) {
    const status = await graphGet(`${containerId}?fields=status_code`, accessToken);
    const statusCode = status.status_code;

    if (statusCode === 'FINISHED') {
      return;
    }

    if (statusCode === 'ERROR') {
      throw new Error(
        `Instagram container ${containerId} failed processing. Check your image URL is publicly accessible.`
      );
    }

    // IN_PROGRESS or other — wait and retry
    await new Promise((resolve) => setTimeout(resolve, CONTAINER_POLL_INTERVAL_MS));
  }

  throw new Error(
    `Instagram container ${containerId} did not finish processing within ${CONTAINER_POLL_TIMEOUT_MS / 1000}s timeout.`
  );
}

export async function POST(req: NextRequest) {
  const isAdmin = await getAdminFromRequest();
  if (!isAdmin) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const igUserId = process.env.INSTAGRAM_USER_ID;
  const accessToken = process.env.INSTAGRAM_ACCESS_TOKEN;
  if (!igUserId || !accessToken) {
    return NextResponse.json(
      { error: 'Instagram credentials not configured. Set INSTAGRAM_USER_ID and INSTAGRAM_ACCESS_TOKEN in your .env file.' },
      { status: 500 }
    );
  }

  const { id } = await req.json();
  
  const doc = await getGoogleSheet();
  const sheet = doc.sheetsByIndex[0];
  const rows = await sheet.getRows();
  
  const confessionRow = rows.find(row => row.get('id') === id.toString() || row.get('id') === id);
  if (!confessionRow) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  let status = confessionRow.get('status');
  if (status !== 'approved' && status !== 'pending') {
    return NextResponse.json(
      { error: 'Only pending or approved confessions can be posted to Instagram.' },
      { status: 400 }
    );
  }

  const baseUrl = getBaseUrl();
  let storedImageUrls: string[] = [];
  let confNumber: number | null = null;

  // If pending, generate images first
  if (status === 'pending') {
    let rawNumber = confessionRow.get('number');
    if (!rawNumber) {
      let maxNumber = 0;
      for (const row of rows) {
        const num = parseInt(row.get('number') || '0');
        if (num > maxNumber) maxNumber = num;
      }
      confNumber = maxNumber + 1;
      confessionRow.set('number', confNumber.toString());
    } else {
      confNumber = parseInt(rawNumber);
    }

    const parts = splitTextIntoParts(confessionRow.get('text') || '');
    const relativeUrls = parts.map((_, index) => `/api/image/${id}/${index}.jpg`);
    storedImageUrls = relativeUrls.map(value => toAbsoluteUrl(baseUrl, value));

    confessionRow.set('parts', JSON.stringify(parts));
    confessionRow.set('imageUrls', JSON.stringify(relativeUrls));
    confessionRow.set('status', 'approved'); // Set to approved first, in case IG posting fails
    confessionRow.set('updatedAt', new Date().toISOString());
    await confessionRow.save();
  } else {
    // It's already approved, just fetch existing image URLs
    const imageUrlsStr = confessionRow.get('imageUrls');
    const existingUrls: string[] = imageUrlsStr ? JSON.parse(imageUrlsStr) : [];
    storedImageUrls = existingUrls.map((value: string) => toAbsoluteUrl(baseUrl, value));
    confNumber = confessionRow.get('number') ? parseInt(confessionRow.get('number')) : null;
  }
  
  const imageUrls = storedImageUrls.length > 0 ? storedImageUrls : [`${baseUrl}/api/image/${id}/0.jpg`];
  const caption = buildCaption(confNumber, process.env.IG_HANDLE || 'bu.confess');

  try {
    // Validate that the base URL is not localhost (Instagram can't reach it)
    if (baseUrl.includes('localhost') || baseUrl.includes('127.0.0.1')) {
      throw new Error(
        'NEXT_PUBLIC_APP_URL points to localhost. Instagram cannot fetch images from localhost. ' +
        'Deploy your app or use a tunneling solution like ngrok, then set NEXT_PUBLIC_APP_URL to the public URL.'
      );
    }

    const creationIds: string[] = [];

    for (const imageUrl of imageUrls) {
      const container = await graphPost(
        `${igUserId}/media`,
        imageUrls.length > 1
          ? { image_url: imageUrl, is_carousel_item: true }
          : { image_url: imageUrl, caption },
        accessToken
      );

      if (!container.id) {
        throw new Error('Instagram media container was created without an id');
      }

      // Wait for the container to finish processing
      await waitForContainerReady(container.id, accessToken);
      creationIds.push(container.id);
    }

    let publishTargetId = creationIds[0];
    if (creationIds.length > 1) {
      const carouselContainer = await graphPost(
        `${igUserId}/media`,
        {
          media_type: 'CAROUSEL',
          children: creationIds,
          caption,
        },
        accessToken
      );

      if (!carouselContainer.id) {
        throw new Error('Instagram carousel container was created without an id');
      }

      // Wait for carousel container to finish too
      await waitForContainerReady(carouselContainer.id, accessToken);
      publishTargetId = carouselContainer.id;
    }

    const published = await graphPost(
      `${igUserId}/media_publish`,
      { creation_id: publishTargetId },
      accessToken
    );

    if (!published.id) {
      throw new Error('Instagram publish response did not include a media id');
    }

    let permalink: string | null = null;
    try {
      const mediaDetails = await graphGet(`${published.id}?fields=id,permalink`, accessToken);
      permalink = mediaDetails.permalink || null;
    } catch (error) {
      console.error('Failed to fetch Instagram permalink', {
        publishId: published.id,
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }

    confessionRow.set('status', 'posted');
    confessionRow.set('igPostId', published.id);
    confessionRow.set('igPermalink', permalink || '');
    confessionRow.set('updatedAt', new Date().toISOString());
    await confessionRow.save();

    return NextResponse.json({
      success: true,
      igPostId: published.id,
      igPermalink: permalink,
      publishedChildrenCount: creationIds.length,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Unknown Instagram publish error';
    console.error('Instagram posting failed:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
