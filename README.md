# SmartDesk AI

> AI-powered desktop file organizer built with **Electron + React + Node.js + Supabase**, classified by **IBM watsonx Orchestrate**.

---

## ✨ Features
- 📂 **Folder monitoring** via Chokidar — watches selected directories in real-time
- 🤖 **AI classification** using IBM watsonx Granite models (with rule-based fallback)
- ✅ **Approval workflow** — confirm or reject every suggested file move
- 📊 **Live dashboard** with animated stats and event feed
- 🗄️ **Supabase (Postgres)** for persistent event storage
- 🖥️ **Custom frameless window** with glass-morphism dark UI

## 🚀 Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env
# Edit .env with your Supabase + watsonx credentials

# 3. Run the Supabase schema
# Paste src/db/schema.sql into the Supabase SQL Editor

# 4. Start in development mode (Electron + React + Express)
npm run dev
```

## 📁 Project Structure

```
smartdesk-ai/
├── src/
│   ├── main/           # Electron main process (TypeScript)
│   │   ├── index.ts    # BrowserWindow, IPC handlers
│   │   ├── preload.ts  # contextBridge API
│   │   └── ipcHandlers.ts
│   ├── renderer/       # React + Tailwind + Framer Motion
│   │   ├── pages/      # Dashboard, Approvals, Activity, Settings
│   │   ├── components/ # Layout, StatCard, FileEventFeed
│   │   ├── hooks/      # useStats, useApprovals, useWatcherEvents, useActivity
│   │   └── styles/     # globals.css (Tailwind + custom design tokens)
│   ├── backend/        # Express REST + Socket.IO
│   │   ├── routes/     # classify, activity, moves, folders, stats
│   │   └── services/   # watsonxService.js (IBM API + fallback)
│   ├── db/             # Supabase client + schema.sql
│   └── watcher/        # Chokidar file watcher
├── .env.example
├── package.json
├── vite.config.ts
├── tailwind.config.js
└── tsconfig.json
```

## 🔑 Environment Variables

| Variable | Description |
|---|---|
| `SUPABASE_URL` | Your Supabase project URL |
| `SUPABASE_ANON_KEY` | Supabase anon public key |
| `WATSONX_API_KEY` | IBM Cloud API key |
| `WATSONX_PROJECT_ID` | watsonx project ID |
| `WATSONX_MODEL_ID` | Granite model ID (default: `ibm/granite-13b-instruct-v2`) |

## 🛠️ Scripts

| Command | Description |
|---|---|
| `npm run dev` | Start Electron + React + Express concurrently |
| `npm run build` | Build renderer + main process |
| `npm run dist` | Package into distributable (electron-builder) |

## 📄 License
MIT
