# InfinityVault

InfinityVault is a private, Google Photos-style timeline for photos and videos. Users select media from their device gallery, browse it by the original capture time, and back up the original files to their own Telegram Saved Messages.

## Features

- Responsive photo and video timeline
- EXIF capture-time detection for photos
- Video dimensions and duration detection
- Newest-first and oldest-first sorting
- Search and photo/video filters
- Telegram account connection with phone verification and optional 2FA
- Encrypted Telegram session storage on the backend
- Persistent SQLite media records and upload jobs
- Background uploads to Saved Messages
- Clear queued, waiting, uploading, backed-up, and retry-needed states
- View original media directly from Telegram
- Download the original Telegram file with its original filename
- Retry handling for failed uploads and temporary Telegram errors

## Architecture

```text
Device gallery
      ↓
InfinityVault web app
      ↓
FastAPI backend
      ├── SQLite metadata and upload queue
      ├── encrypted Telegram session
      └── background Telethon worker
                  ↓
          Telegram Saved Messages
```

The gallery uses local previews for responsiveness. **View original** and **Download original** retrieve the backed-up file through Telegram. Downloaded Telegram media is cached locally in `backend/data/telegram-cache`.

## Requirements

- Node.js 18+
- Python 3.11+
- A Telegram `api_id` and `api_hash` from [my.telegram.org](https://my.telegram.org)

Telegram currently limits individual uploads to 2 GB for free accounts and 4 GB for Premium accounts. The API credentials do not bypass Telegram’s file-size, rate, or account limits.

## Local setup

### 1. Configure Telegram privately

```bash
cd backend
cp .env.example .env
```

Fill in `TELEGRAM_API_ID` and `TELEGRAM_API_HASH` in `backend/.env`. The `.env` file is ignored by Git and must never be committed.

### 2. Start the backend

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000 --env-file .env
```

### 3. Start the frontend

```bash
cd frontend
npm install
npm run dev
```

Open [http://127.0.0.1:5173/](http://127.0.0.1:5173/).

Then choose **Connect Telegram**, enter the phone number connected to Telegram, enter the verification code, and provide the Telegram 2FA password if requested.

## Persistence

Local runtime data is intentionally ignored by Git:

```text
backend/data/infinityvault.db       SQLite metadata and upload jobs
backend/data/uploads/               local gallery previews/originals
backend/data/telegram-cache/       Telegram viewer/download cache
backend/data/session.key            encryption key for Telegram sessions
```

Keep `backend/data/` and the private environment file when stopping and restarting the app. Queued and interrupted uploads are restored when the backend starts. Telegram copies remain in Saved Messages independently of this local cache.

## Security

- Telegram sessions are encrypted at rest and never sent to the browser.
- API credentials, session keys, databases, uploads, and caches are ignored by Git.
- Do not paste credentials into source files, README files, logs, or commits.
- This local build uses a browser-generated client ID. Add real application authentication before deploying for multiple users.

## Checks

```bash
cd frontend && npm run build
cd ../backend && .venv/bin/python -m compileall -q app
```
