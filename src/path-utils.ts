import { isAbsolute, relative, resolve } from "node:path";

/**
 * Whether `path` is `root` itself or nested inside it, after resolving both to
 * absolute form. Used to keep file operations confined to an allowed root
 * (skill resources, the extension storage dir) and reject `..` escapes.
 */
export function isPathInsideOrEqual(path: string, root: string): boolean {
	const resolvedPath = resolve(path);
	const resolvedRoot = resolve(root);
	const rel = relative(resolvedRoot, resolvedPath);
	return rel.length === 0 || (!rel.startsWith("..") && !isAbsolute(rel));
}
