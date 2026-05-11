**Brunel** orchestrates a team of Claude coding agents to work on GitHub issues and file pull requests:

* Tag an issue `brunel:ready`, and it will be assigned to an agent
* Agents automatically respond to test failures, code reviews, and any comments you leave on the PR
* Agents run in your terminal, and use any skills you have installed

## Quickstart

1. Install the Brunel GitHub App on your repo: [github.com/apps/brunel-foreman](https://github.com/apps/brunel-foreman)
2. Install the Brunel client locally: `npm install -g brunel-agent`
3. Strongly recommended: install the skills at [jasoncrawford/claude-skills](https://github.com/jasoncrawford/claude-skills) and also [obra/superpowers](https://github.com/obra/superpowers#claude-code)
4. Put an Anthropic key/token in your env: `export ANTHROPIC_API_KEY=sk-ant-...` or `export CLAUDE_CODE_OAUTH_TOKEN=sk-ant-...`
5. Run `brunel` in your repo
6. Tag issues `brunel:ready` in GitHub

Go to [brunel.dev](https://brunel.dev) and find your repo in the dashboard to see the status of tasks and workers.
