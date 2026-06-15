# BU Confessions

Anonymous confession submission and Instagram auto-posting app for BU.

## Stack
- **Next.js 14** (App Router + API routes)
- **Prisma + SQLite** (database)
- **canvas** (1080x1080 image generation)
- **Instagram Graph API** (auto-posting)
- **Tailwind CSS** (styling)

## Setup

### 1. Clone and install
```bash
git clone https://github.com/thevikramrajput/buconfess
cd buconfess
npm install
```

### 2. Configure environment
```bash
cp .env.example .env
# Edit .env with your values
```

### 3. Setup database
```bash
npx prisma migrate dev --name init
npx ts-node prisma/seed.ts
```

### 4. Run
```bash
npm run dev
```

## Usage

- **Confessions form**: `/` - public page where anyone can submit
- **Admin dashboard**: `/admin` - login and manage confessions

### Admin workflow
1. Login at `/admin`
2. See pending confessions
3. Click **Generate Images** to create 1080x1080 JPEGs and preview them
4. Click **Post to Instagram** to publish via Graph API

## Instagram Graph API Setup
1. Convert @bu.confess to Professional (Creator/Business) account
2. Link it to a Facebook Page
3. Create a Meta Developer App
4. Add `instagram_basic` and `instagram_content_publish` permissions
5. Generate a long-lived access token
6. Add `INSTAGRAM_ACCESS_TOKEN` and `INSTAGRAM_USER_ID` to `.env`

## Deploy on Railway
1. Push to GitHub
2. Create new Railway project from this repo
3. Add all environment variables from `.env.example`
4. Railway auto-builds and deploys
