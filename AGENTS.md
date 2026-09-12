# AGENTS.md

## Commands

- `npm install` - Install dependencies
- `npm run dev` - Start dev server
- `npm run build` - Build for production
- `npm test` - Run tests
- `npm run lint` - Run linter
- `npm run typecheck` - Run type checker

## Order

Run in this order before committing: `lint -> typecheck -> test`

## Notes

- Check `package.json` for exact scripts
- Use `.env` for environment variables (never commit secrets)
- Run `npm run build` before deployment