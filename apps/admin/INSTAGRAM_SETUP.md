# BU Confessions — Instagram Graph API Setup Guide

This guide walks you through setting up the Instagram Graph API so confessions can be automatically posted from the admin panel.

---

## Prerequisites

1. **A Facebook account** that owns/manages a Facebook Page
2. **An Instagram Professional account** (Business or Creator) connected to that Facebook Page
3. **A Meta Developer account** at [developers.facebook.com](https://developers.facebook.com)

---

## Step 1: Convert to Instagram Professional Account

1. Open Instagram → Settings → Account → Switch to Professional Account
2. Choose **Business** or **Creator**
3. Connect it to your **Facebook Page** when prompted

> If you don't have a Facebook Page, create one first at [facebook.com/pages/create](https://www.facebook.com/pages/create)

---

## Step 2: Create a Meta (Facebook) App

1. Go to [developers.facebook.com/apps](https://developers.facebook.com/apps)
2. Click **Create App**
3. Choose **Business** type
4. Name it (e.g., "BU Confessions Bot")
5. Once created, go to **App Dashboard**

---

## Step 3: Add Instagram Graph API Product

1. In your app dashboard, click **Add Product**
2. Find **Instagram Graph API** and click **Set Up**
3. This adds the necessary permissions

---

## Step 4: Generate Access Token

### Option A: Using Graph API Explorer (Quick Testing)

1. Go to [Graph API Explorer](https://developers.facebook.com/tools/explorer/)
2. Select your app from the dropdown
3. Click **Generate Access Token**
4. Grant these permissions:
   - `instagram_basic`
   - `instagram_content_publish`
   - `pages_show_list`
   - `pages_read_engagement`
5. Copy the token — this is a **short-lived token** (valid ~1 hour)

### Option B: Get a Long-Lived Token (Recommended for Production)

Short-lived tokens expire quickly. Convert to a long-lived token:

1. Get your **App ID** and **App Secret** from your app's Settings → Basic
2. Exchange the short-lived token for a long-lived one:

```
GET https://graph.facebook.com/v20.0/oauth/access_token
  ?grant_type=fb_exchange_token
  &client_id={APP_ID}
  &client_secret={APP_SECRET}
  &fb_exchange_token={SHORT_LIVED_TOKEN}
```

3. The response contains a long-lived token (valid ~60 days)
4. For a **never-expiring page token**, use the long-lived user token to get page tokens:

```
GET https://graph.facebook.com/v20.0/me/accounts
  ?access_token={LONG_LIVED_USER_TOKEN}
```

This returns page tokens that **never expire** as long as the user token was long-lived.

---

## Step 5: Get Your Instagram User ID

Using the access token from Step 4:

1. First, get your Facebook Page ID:
```
GET https://graph.facebook.com/v20.0/me/accounts?access_token={TOKEN}
```

2. Then get the Instagram Business Account ID connected to that page:
```
GET https://graph.facebook.com/v20.0/{PAGE_ID}?fields=instagram_business_account&access_token={TOKEN}
```

3. The response will contain:
```json
{
  "instagram_business_account": {
    "id": "17841400123456789"  ← This is your INSTAGRAM_USER_ID
  }
}
```

---

## Step 6: Configure Your .env File

```env
# Instagram Graph API
INSTAGRAM_ACCESS_TOKEN="your_long_lived_access_token_here"
INSTAGRAM_USER_ID="17841400123456789"

# Public URL of your deployed app (Railway, etc.)
# Instagram needs to fetch images from this URL, so it MUST be public
NEXT_PUBLIC_APP_URL="https://your-app.up.railway.app"

# Optional customization
IG_CAPTION_PREFIX="BU Confession"
IG_HANDLE="bu.confess"
```

---

## Step 7: Verify Everything Works

1. Deploy your app to Railway (or wherever your public URL is)
2. Submit a confession at `/`
3. Go to `/admin`, login, and click **Approve & Generate Images**
4. Click **Post to Instagram**
5. Check your Instagram account — the post should appear!

---

## Troubleshooting

### "Instagram credentials not configured"
→ Make sure `INSTAGRAM_USER_ID` and `INSTAGRAM_ACCESS_TOKEN` are set in your `.env`

### "Instagram container failed processing. Check your image URL is publicly accessible."
→ Your `NEXT_PUBLIC_APP_URL` must be a publicly accessible URL. Instagram's servers need to download the image from your app. `localhost` will NOT work.

### "Graph API request failed with status 400"
→ Usually means the access token is expired or doesn't have the right permissions. Regenerate your token with `instagram_content_publish` permission.

### "OAuthException: Invalid OAuth access token"
→ Your token has expired. Generate a new long-lived token (see Step 4B).

### "(#9004) There was a timeout while attempting to download the image"
→ Your server is too slow to respond, or the image URL is not reachable from Instagram's servers. Check that `/api/image/{id}/{part}` returns a JPEG when accessed from a browser.

### Token Expiry
- Short-lived tokens: ~1 hour
- Long-lived user tokens: ~60 days
- Page tokens from long-lived user tokens: **Never expire**

**For production, always use a page token derived from a long-lived user token.**

---

## Security Notes

- Never commit your `.env` file to git (it's already in `.gitignore`)
- Keep your App Secret private
- Use environment variables on Railway (Settings → Variables)
- The admin panel is protected by JWT auth, but make sure to use a strong password
