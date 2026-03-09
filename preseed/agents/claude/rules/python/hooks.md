---
paths:
  - "**/*.py"
  - "**/*.pyi"
---
# Python Hooks

> Python-specific hook configuration.

## PostToolUse Hooks

Configure in `~/.claude/settings.json`:

- **black/ruff**: Auto-format `.py` files after edit
- **mypy/pyright**: Run type checking after editing `.py` files

## Warnings

- Warn about `print()` statements in edited files (use `logging` module instead)
