**brunel** is a GitHub-driven autonomous coding agent. Label a GitHub issue `brunel:ready`, and brunel picks it up, spins up a Claude-powered worker in your repo, and reports back when done — all from your terminal, with you in the loop.

## Quickstart

```
# Install the brunel GitHub App on your repo at github.com/apps/brunel-foreman
npm install -g brunel-agent
export ANTHROPIC_API_KEY=sk-ant-...
cd my-repo
brunel
```

For more detail, see the [GitHub repo](https://github.com/jasoncrawford/brunel).
