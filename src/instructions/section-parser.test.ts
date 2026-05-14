import { describe, expect, it } from "vitest";
import { getMarkdownSection, parseMarkdownSections } from "./section-parser";

describe("parseMarkdownSections", () => {
	it("extracts sections from markdown headings", () => {
		const sections = parseMarkdownSections(
			[
				"# Git Instructions",
				"",
				"intro",
				"",
				"## commit.work_item",
				"",
				"commit text",
				"",
				"## recovery.external_commit",
				"",
				"recovery text",
			].join("\n"),
		);

		expect(sections).toMatchObject([
			{
				name: "Git Instructions",
				level: 1,
			},
			{
				name: "commit.work_item",
				level: 2,
				content: "commit text",
			},
			{
				name: "recovery.external_commit",
				level: 2,
				content: "recovery text",
			},
		]);
	});

	it("keeps nested lower-level headings inside the parent section", () => {
		const content = [
			"## work_item.tdd",
			"",
			"main text",
			"",
			"### red",
			"",
			"write tests",
			"",
			"## details",
			"",
			"extra",
		].join("\n");

		expect(getMarkdownSection(content, "work_item.tdd")).toBe(
			["main text", "", "### red", "", "write tests"].join("\n"),
		);
	});

	it("matches section names case-insensitively", () => {
		const content = "## Commit.Work_Item\n\ntext";

		expect(getMarkdownSection(content, "commit.work_item")).toBe("text");
	});

	it("strips closing heading markers", () => {
		const content = "## details ##\n\ntext";

		expect(parseMarkdownSections(content)[0]).toMatchObject({
			name: "details",
			content: "text",
		});
	});

	it("returns null when a section is missing", () => {
		expect(getMarkdownSection("## details\n\ntext", "missing")).toBeNull();
	});
});
