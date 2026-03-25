# Mechanics Simulator

Web app single-page in React + TypeScript per costruzione e simulazione cinematica semplificata di meccanismi piani 2D.

## Requisiti

- Node.js 20+ consigliato
- npm 10+ consigliato

## Avvio locale

```bash
npm install
npm run dev
```

Apri poi l'URL mostrato da Vite nel browser.

## Build produzione

```bash
npm run build
npm run preview
```

## Deploy su Cloudflare Workers

1. Build locale:

```bash
npm ci
npm run build
```

2. Login Cloudflare:

```bash
npx wrangler login
```

3. Deploy:

```bash
npx wrangler deploy
```

Il Worker in `worker/index.ts` serve i file statici da `dist` e applica gli header di sicurezza.

## Funzioni incluse

- area di lavoro 2D con griglia, zoom, pan, coordinate e snap opzionale
- creazione di nodi, cerniere, aste rigide, supporti fissi e carrelli
- selezione, trascinamento, duplicazione ed eliminazione
- pannello proprieta per modificare posizione, lunghezze, angoli e tipo vincolo
- solver iterativo 2D semplificato per rispettare in modo plausibile aste e vincoli
- salvataggio e caricamento in JSON
- demo iniziale biella-manovella con pistone su guida

## Struttura progetto

- `src/components`: UI e viewport interattiva
- `src/lib`: geometria, manipolazione modello e solver
- `src/data`: meccanismo demo iniziale
- `src/types`: tipi TypeScript condivisi
