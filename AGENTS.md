# Repository guidelines

## Committing changes

- Only commit changes when the user explicitly asks for a commit. Never create a commit proactively.

## Commit messages

Use Conventional Commits for every commit:

```text
type: subject
```

- Use a lowercase type: `feat`, `fix`, `docs`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, or `revert`.
- Write the subject in the imperative mood, keep it concise, and do not end it with a period.
- Prefer Chinese for the subject when it reads naturally. Keep technical terms, commands, proper names, or clearer established wording in English instead of forcing a Chinese translation.
- Use `feat` for a new user-visible capability and `fix` for a user-visible bug fix.
- Add `!` before the colon for a breaking change (for example, `feat!: remove legacy output format`) and explain it in a `BREAKING CHANGE:` footer.
- An optional scope is allowed when useful (for example, `fix(recover): handle missing source content`).

Examples:

```text
feat: support remote Chrome endpoints
fix(recover): reject paths outside the output directory
docs: clarify Source Map limitations
chore: 更新发布配置
```
