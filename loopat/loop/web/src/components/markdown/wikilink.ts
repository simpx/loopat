/**
 * remark plugin: convert `[[Target]]` and `[[Target|Display]]` into a special
 * link node that downstream rendering can pick up. We emit a regular `link`
 * mdast node with `url = "wikilink:<target>"` so react-markdown's `a`
 * renderer sees it and we handle clicks ourselves.
 */
import type { Plugin } from "unified"
import type { Root, Text, Link, Parent } from "mdast"

const PATTERN = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g

export const remarkWikilink: Plugin<[], Root> = () => {
  return (tree) => {
    visit(tree, "text", (node, index, parent) => {
      if (!parent || index === undefined) return
      const value = (node as Text).value
      if (!value.includes("[[")) return
      PATTERN.lastIndex = 0
      let m: RegExpExecArray | null
      let last = 0
      const nodes: any[] = []
      while ((m = PATTERN.exec(value)) !== null) {
        if (m.index > last) {
          nodes.push({ type: "text", value: value.slice(last, m.index) })
        }
        const target = m[1].trim()
        const display = (m[2] ?? target).trim()
        const link: Link = {
          type: "link",
          url: `wikilink:${target}`,
          children: [{ type: "text", value: display }],
        }
        nodes.push(link)
        last = m.index + m[0].length
      }
      if (last === 0) return
      if (last < value.length) {
        nodes.push({ type: "text", value: value.slice(last) })
      }
      ;(parent as Parent).children.splice(index, 1, ...nodes)
      return ["skip", index + nodes.length]
    })
  }
}

// minimal mdast visitor (avoid pulling unist-util-visit dep just for this)
function visit(
  tree: any,
  type: string,
  cb: (node: any, index: number | undefined, parent: any | undefined) => any,
) {
  function walk(node: any, index: number | undefined, parent: any | undefined): any {
    if (node.type === type) {
      const r = cb(node, index, parent)
      if (Array.isArray(r) && r[0] === "skip") return r
    }
    if (Array.isArray(node.children)) {
      let i = 0
      while (i < node.children.length) {
        const r = walk(node.children[i], i, node)
        if (Array.isArray(r) && r[0] === "skip") {
          i = r[1] as number
          continue
        }
        i++
      }
    }
    return undefined
  }
  walk(tree, undefined, undefined)
}
