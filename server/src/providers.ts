/**
 * Explicit git-host provider registry. Importing this module registers every
 * built-in GitHostProvider via side effect.
 *
 * To add a git platform in a fork / extension: implement a GitHostProvider
 * (see git-host.ts), ship the file, and add ONE import line below. Nothing else
 * in loopat core needs to change.
 */
import "./github" // registers githubProvider
// import "./gitlab"    // ← second-party platforms: add a line, ship the file
// import "./acme-git"
