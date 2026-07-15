# ◎ Recall

A memory training app that progressively removes high-imagery words from a passage and prompts you to recall them by voice or typing.

---

## Setup

### 1. Get an Anthropic API key
Go to [console.anthropic.com](https://console.anthropic.com) → API Keys → Create Key. Copy it.

### 2. Install dependencies
```bash
npm install
```

### 3. Add your API key
Create a file called `.env` in the project root:
```
VITE_ANTHROPIC_API_KEY=sk-ant-your-key-here
```

### 4. Run locally
```bash
npm run dev
```
Open [http://localhost:5173](http://localhost:5173) in your browser.

---

## Deploy to Vercel (free, shareable link)

1. Push this repo to GitHub
2. Go to [vercel.com](https://vercel.com) → New Project → import your repo
3. Before clicking Deploy, go to **Environment Variables** and add:
   - Key: `VITE_ANTHROPIC_API_KEY`
   - Value: your API key from step 1
4. Click **Deploy**

You'll get a public URL (e.g. `recall-trainer.vercel.app`) anyone can open on their phone.

---

## File structure
```
recall-trainer/
├── index.html
├── package.json
├── vite.config.js
├── .env          ← you create this (never commit it)
├── .env.example  ← template
└── src/
    ├── main.jsx
    └── App.jsx   ← entire app lives here
```
