# Goal mode

Run one long-lived goal until it is complete:

```text
/goal Refactor the auth module and keep tests green
```

Use `/goal` without an objective to inspect the current goal. Press Escape to stop it, just like any other running agent turn.

The extension persists the goal in the Pi session and automatically continues after settled turns and restarts. The main agent can use available subagents for parallel work; when it claims completion, the extension uses a subagent for independent final verification when one is available. There are no turn or token budgets, pause states, or lifecycle commands.

## Install

```bash
pi install git:github.com/Federicocervelli/pi-goal
```
