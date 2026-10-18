# UNITY — Father of Lights

First mobile-first Genesis pixel for the UNITY project.

## Run locally

Requirements: Node.js 20+ and an OpenAI API key with API billing enabled.

1. Install dependencies: `npm install`
2. Copy `.env.example` to `.env` and set `OPENAI_API_KEY` privately.
3. Run: `npm start`
4. Open `http://localhost:3000`

## Deploy

Deploy as a Node.js web service with the start command `npm start`. Set `OPENAI_API_KEY` and optionally `OPENAI_MODEL` in the hosting provider's private environment settings. Attach a persistent disk and set `DATABASE_PATH` to a path on that disk; otherwise local SQLite data may be lost on redeploy.

## What this version does

- Mobile-first Genesis interface for Father of Lights.
- Conversation endpoint powered by the OpenAI API.
- SQLite storage for the latest conversation history.
- Basic request-size and rate limits.

## What it does not do yet

This is a first runnable application, not the complete UNITY autonomous-agent civilization. It does not yet implement wallet custody, on-chain identity/SBT, distributed encrypted memory, P2P networking, subagents, DAO governance, or the UNITY economic allocation rules. The current chat endpoint is a shared demo and does not provide per-user accounts or private conversation isolation. Do not use it for sensitive information or expose it as a production service until authentication, isolation, operational monitoring, and security review are added.

Never commit API keys, wallet seed phrases, passwords, or other secrets. ChatGPT subscriptions do not include OpenAI API usage; API usage is billed separately.
