import { createHash } from "node:crypto";

/** Hex SHA-256 of `content`. The one hashing helper for content fingerprints
 * (artifact staleness, VRF source hashes, contract paths). */
export function sha256(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}
