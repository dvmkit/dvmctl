# dvmctl

Build and deploy Digital Vending Machines: pay-per-use HTTPS services that AI agents can find, pay, and call with no account or API key. Ships the `build-dvm` agent skill.

Alpha software. This is a pre-1.0 alpha; breaking changes are announced in the [release notes](./CHANGELOG.md).

## Install

Node.js 22 or later and npm are required.

Install the CLI:

```bash
npm install --global @dvmkit/dvmctl
```

## For agents

Install the complete bundled skill directory so its task modules and payment recipes remain available. For Claude Code:

```bash
mkdir -p ~/.claude/skills
cp -R "$(npm root --global)/@dvmkit/dvmctl/skills/build-dvm" ~/.claude/skills/
```

Codex uses `~/.codex/skills/` and other Agent Skills harnesses use `~/.agents/skills/`; [agent setup](https://dvmkit.com/docs/agent-setup) has the full list.

After `npm update --global @dvmkit/dvmctl`, copy the skill again.

The skill entry routes new builds, testing, deployment, operation, recovery, and retirement to separate files. Read only the procedure for the current task. Exact command and SDK contracts live in the [published docs](https://dvmkit.com/llms.txt).

## First DVM

After copying the skill, ask your agent: “Load build-dvm, create a service in my-dvm, and prove a local job works before deployment.” The [new-builder procedure](skills/build-dvm/new-builder.md) covers handler, environment, and testing decisions.

To scaffold directly, run `dvmctl create my-dvm`, enter the directory, install its dependencies, then run `npm run typecheck`, `npm test`, and `dvmctl validate`. Start local development with `dvmctl dev handler.ts`. The generated README explains the environment. Follow the skill's testing procedure to prove a job round-trip, then its deployment procedure when local checks pass.

## Reference

Commands return structured output by default. Use `--human` for terminal output and `dvmctl --help` for the command list.

Payment setup, secrets, content holds, financial export, and retirement are covered by the skill's task procedures and the [dvmctl reference](https://dvmkit.com/docs/cli-dvmctl).

The CLI and bundled skill use the exact SDK dependency recorded in [package.json](package.json). Scaffolds inherit that selection.

## Security

Report vulnerabilities privately; see [SECURITY.md](SECURITY.md).

## Contributing

Issues and discussions are welcome; pull requests are closed automatically. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Support

For help, see [SUPPORT.md](SUPPORT.md).

## Trademarks

See [TRADEMARKS.md](TRADEMARKS.md) for name and logo usage.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
