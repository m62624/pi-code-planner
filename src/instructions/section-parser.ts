export interface MarkdownSection {
	name: string;
	normalizedName: string;
	level: number;
	content: string;
}

function normalizeSectionName(name: string): string {
	return name.trim().toLowerCase();
}

function parseHeading(line: string): { level: number; name: string } | null {
	const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
	if (!match) return null;

	return {
		level: match[1].length,
		name: match[2].trim(),
	};
}

export function parseMarkdownSections(content: string): MarkdownSection[] {
	const lines = content.split(/\r?\n/);
	const sections: MarkdownSection[] = [];

	for (let index = 0; index < lines.length; index += 1) {
		const heading = parseHeading(lines[index]);
		if (!heading) continue;

		const body: string[] = [];
		for (let bodyIndex = index + 1; bodyIndex < lines.length; bodyIndex += 1) {
			const nextHeading = parseHeading(lines[bodyIndex]);
			if (nextHeading && nextHeading.level <= heading.level) {
				break;
			}
			body.push(lines[bodyIndex]);
		}

		sections.push({
			name: heading.name,
			normalizedName: normalizeSectionName(heading.name),
			level: heading.level,
			content: body.join("\n").trim(),
		});
	}

	return sections;
}

export function getMarkdownSection(
	content: string,
	sectionName: string,
): string | null {
	const normalizedName = normalizeSectionName(sectionName);
	const section = parseMarkdownSections(content).find(
		(candidate) => candidate.normalizedName === normalizedName,
	);
	return section?.content ?? null;
}
