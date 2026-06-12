# GPT Reader

GPT Reader is a Manifest V3 Chrome extension that adds a synchronized Markdown
outline to long ChatGPT answers.

## Features

- Injects only on `chatgpt.com` and `chat.openai.com`.
- Builds a left-side table of contents from assistant answer headings.
- Highlights the current heading while the ChatGPT page scrolls.
- Clicks a heading to jump to the matching answer section.
- Expands the current answer to the configured depth and keeps other answers compact.
- Stores settings with `chrome.storage.sync`.

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
```

Load the generated `dist` directory from `chrome://extensions` with Developer
mode enabled.
