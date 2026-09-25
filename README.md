# Can you beat AI in Connect Four?

Play Connect Four against different AIs: **[connect4.theclosedloop.co](https://connect4.theclosedloop.co)**

| Opponent | How it picks a move |
| --- | --- |
| GPT-6 Luna / Sol | OpenAI Responses API, adjustable thinking level |
| GPT-6 Astra | OpenAI, pinned to low thinking (it's expensive) |
| JEV | [TypeSafe](https://docs.typesafe.ai) System One model; code computes each move's tactical effect, Jev judges |
| Negamax | Perfect solver after [Pascal Pons](http://blog.gamesolver.org): alpha-beta, bitboards, transposition table. Runs in your browser; falls back to a deep search in the opening |

No dependencies, just [Bun](https://bun.sh) and one HTML file.

## Run locally

```sh
cp .env.example .env   # add OPENAI_API_KEY and TYPESAFE_API_KEY
bun dev                # http://localhost:3000
```

## Deploy (Cloudflare Workers)

```sh
bunx wrangler secret put OPENAI_API_KEY    # also TYPESAFE_API_KEY, TURNSTILE_SECRET, SESSION_SECRET
bun run deploy
```

In production the AI endpoints are protected by Cloudflare Turnstile, a signed session cookie, and a per-IP rate limit. Domain and Turnstile site key are in `wrangler.jsonc`.

## License

MIT
