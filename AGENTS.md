# Repository guidelines

## Commit messages

Use Conventional Commits for every commit:

```text
type: subject
```

- Use a lowercase type: `feat`, `fix`, `docs`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, or `revert`.
- Write the subject in the imperative mood, keep it concise, and do not end it with a period.
- Use `feat` for a new user-visible capability and `fix` for a user-visible bug fix.
- Add `!` before the colon for a breaking change (for example, `feat!: remove legacy output format`) and explain it in a `BREAKING CHANGE:` footer.
- An optional scope is allowed when useful (for example, `fix(recover): handle missing source content`).

Examples:

```text
feat: support remote Chrome endpoints
fix(recover): reject paths outside the output directory
docs: clarify Source Map limitations
```
