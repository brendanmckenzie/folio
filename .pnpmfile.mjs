// pnpm prepares a git dependency by running `pnpm install` in the fetched tree, as a
// lifecycle script it names `pnpm-install` (pnpm's exec/prepare-package), and that
// install reads this repository's pnpm-workspace.yaml. Left alone it installs every
// workspace member (tooling/, examples/demo, examples/starter): 262 packages, about
// 230 MB, where `prepare` needs the root's devDependencies alone (89, about 50 MB).
// Narrow that one install to the root project. A contributor's or CI's
// `pnpm install` never runs under that lifecycle event, so it stays recursive.
// If pnpm ever renames the event this stops matching and the install is merely
// the full workspace again; release.mjs's pnpm smoke stage fails on that.
export const hooks = {
  updateConfig(config) {
    if (process.env.npm_lifecycle_event === "pnpm-install") config.recursiveInstall = false;
    return config;
  },
};
