# Mill documentation design review

Reviewed October 3, 2026 against the full accessible history of **Towbar: Implementation** (`01a06ce6-a6ba-7721-ab56-cc400d65605c`): 1,217 turns, including 722 turns with user messages, from September 4 through October 3. The review follows the user's requests and later corrections. Assistant reports provide context but do not establish preferences or approval.

The owner approved Mill's logo and palette on October 3. The documentation's typography, capitalization and wording were rejected. Hosting is **mill.fyi**. The revised direction is a Mintlify homepage and documentation on that domain, following Towbar's shared shell. Public deployment and repository visibility remain separate decisions.

## Recovered feedback

### Copy and hierarchy

| Date         | User feedback                                                                                                                                                                                       | Implication for Mill                                                                                                                     |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| September 5  | The homepage looked poor and generic; simplify it.                                                                                                                                                  | Use a clear product description, restrained sections and purposeful links. Decoration does not resolve weak hierarchy.                   |
| September 5  | Replace the hero title with Open-Source / Git-native PaaS. Remove the product-category eyebrow, infrastructure/license strip and the Every release, in view paragraph.                              | Put the product and its function in the heading. Remove redundant introductions and technical badge strips.                              |
| September 5  | Remove the workspace/example header above the screenshot. Replace the A home for your apps… wording with a direct description of deployment; the suggested description was accepted.                | Describe actual actions: organize tasks, assign people, discuss work and connect clients. Avoid metaphors and filler around screenshots. |
| September 5  | Shorten Documentation to Docs. Keep centered search and GitHub stars, use Docs as the navbar CTA, and remove the duplicate search icon.                                                             | Use one native header and search, with short navigation labels and source access.                                                        |
| September 5  | The title in docs/index.mdx felt stale.                                                                                                                                                             | Keep metadata, homepage headings and visible copy consistent.                                                                            |
| September 6  | Replace duplicated README getting-started instructions with Mintlify links. Simplify the confusing documentation-link matrix.                                                                       | Maintain one guide source and a few clear entry points.                                                                                  |
| September 6  | A numerical limit was only a ballpark; do not put it in the docs.                                                                                                                                   | Document real behavior and limits. Avoid invented counts.                                                                                |
| September 22 | Use brief hero copy about deploying from Git to owned servers, followed by previews and monitoring. Keep the first line on one desktop row. Primary CTA: Explore in GitHub; secondary: Get started. | This supersedes the earlier Deploy in minutes CTA. Review copy, action hierarchy and responsive wrapping together.                       |
| September 22 | Remove the Start with one server footer and use the documentation footer on the homepage.                                                                                                           | Remove Mill's separate closing slogan and custom footer. Use one native Mintlify footer.                                                 |

### Navigation and content

| Date         | User feedback                                                                                                | Implication for Mill                                                                                                                          |
| ------------ | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| September 5  | Mintlify sidebar categories were duplicated with lowercase names.                                            | Avoid overlapping generated/manual navigation. Use readable section names once; this was not a request for all-caps labels.                   |
| September 5  | Add comprehensive API routes, authentication and MCP setup documentation.                                    | Make API/MCP guidance discoverable and accurate. Mill's current credentials differ from Towbar's historical model.                            |
| September 22 | Use section cards, like the reviewed Coolify docs, instead of five persistent top-level menu items.          | Introduce native section cards and a focused section dropdown/sidebar.                                                                        |
| September 22 | Rename Guides to Introduction; create granular sections for self-hosting and API/MCP references.             | Organize by reader intent: Introduction, Using Mill, Self-hosting and API & MCP. Scale navigation to Mill's actual scope.                     |
| September 22 | Document all CLI commands and parameters using Mintlify's rich components.                                   | Use native steps, alternatives, parameters and warnings where useful. Document actual Mill operator commands; do not invent a CLI product.    |
| September 22 | Add architecture beside core concepts, explain how OSS components connect and link to relevant source paths. | Give contributors a concise map of Mill's web/API, contracts, PostgreSQL and authentication boundaries.                                       |
| September 22 | Remove the unneeded preview workflow.                                                                        | Remove obsolete/unavailable flows rather than leaving placeholders.                                                                           |
| September 22 | Add migration guides, including Vercel; show candid pros/cons for both products without favoring Towbar.     | Describe capabilities and limits honestly. This is not authorization to advertise Mill import tools or copy Towbar's platform catalog.        |
| September 26 | Remove references to an obsolete secrets feature.                                                            | Keep docs aligned with current contracts: no checklists or comment editing; Agents are removed; external clients use human-owned credentials. |

### Typography, components and screenshots

| Date                          | User feedback                                                                                                                                    | Implication for Mill                                                                                                                                                        |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| September 5                   | Use the actual logo and matching brand color, with correct button/text contrast in both themes.                                                  | Preserve the approved tower mill and brown palette. Do not substitute Towbar artwork.                                                                                       |
| September 5                   | Switch light/dark screenshots with the active theme. Add screenshots where they help explain features.                                           | Review real images at rendered sizes, in both themes.                                                                                                                       |
| September 5, 9, 10, 22 and 26 | Repeatedly refresh screenshots after product changes and optimize assets.                                                                        | Show the current product and retain adequate resolution after optimization.                                                                                                 |
| September 22                  | Screenshots must be crisp, without selected text, development badges, unwanted caret or incorrect zoom. Fix pages extending beyond the viewport. | Capture clean viewport images at suitable density, preserve aspect ratio and verify desktop/mobile overflow.                                                                |
| September 22                  | Use emojis in the roles matrix.                                                                                                                  | Adjacent implementation identifies yes/no/read-only permissions. Use concise visual markers in that table where appropriate; this is not a request for emoji feature grids. |
| September 22                  | Do not highlight a whole code block when the whole example is in scope.                                                                          | Highlight only a relevant subset; otherwise leave the example unhighlighted.                                                                                                |
| October 3, Mill               | Text styles, uppercase and verbiage are outside the user's taste.                                                                                | Remove decorative uppercase labels and exaggerated typography. Use sentence case, concrete product nouns and Towbar's documentation primitives.                             |

The Towbar thread does **not** establish a universal ban on uppercase or one fixed font size for all documentation headings. Mill's current uppercase rejection is a direct instruction. Acronyms such as API, REST, MCP and OAuth keep their correct spelling. Application table/widget/email feedback must not be presented as an explicit documentation type scale.

## Current Towbar implementation

Read-only reference: revision `c464131ca36d935636bc7880f606534854f4dc6a`, inspected October 3.

- `docs/docs.json` uses native Mintlify navigation, a Docs navbar action, GitHub access, breadcrumb eyebrows, system code blocks and one shared footer.
- `docs/docs/index.mdx` briefly introduces the product, then offers native section cards and direct links to reader tasks.
- `docs/style.css` explicitly retains native Mintlify layout and typography for documentation. Custom rules apply to the homepage: medium section headings, a semibold hero and readable supporting copy.
- `docs/index.mdx` uses a literal product-category hero, short supporting text, theme-specific screenshots and sections explaining actual features.

These observations support the recovered feedback. They do not replace rendered review of Mill.

## Mill deviations and corrections

| Current surface | Problem                                                                                              | Correction                                                                          |
| --------------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Hero            | Keep work moving, together describes a mood rather than the product.                                 | State that Mill is a self-hosted task list for teams.                               |
| Eyebrows        | Small, bold, widely tracked uppercase labels introduce an unrequested style.                         | Remove redundant labels; use sentence case where a label helps.                     |
| Sections        | Enough structure to find the next step and Give agents a place in the work add promotional phrasing. | Name boards, tasks, team access and REST/MCP connections directly.                  |
| Closing         | Make room for the work repeats a slogan and CTA.                                                     | Remove the separate campaign-style closing section.                                 |
| Shell           | Separate static-site header/footer diverge from the docs.                                            | Share native Mintlify navigation, search and footer.                                |
| Type            | Heavy default headings and display styling were introduced without matching the reference.           | Follow Towbar's hierarchy deliberately; retain native document typography.          |
| Overview        | Dense paragraphs mix introduction, runtime, credential boundaries and internal release status.       | Start with what Mill does and clear reading paths. Move details to relevant guides. |
| Routing         | The proposed split introduced docs.mill.fyi without an owner decision.                               | Host the homepage and docs at mill.fyi.                                             |
| Acceptance      | Config generation and link checks were treated too close to design completion.                       | Keep visual approval open until actual pages have been reviewed.                    |

## Revision acceptance criteria

- [ ] One Mintlify project serves homepage and docs at mill.fyi, with one header, search and footer. Verify the existing project connection before publication.
- [ ] Concrete homepage copy and purposeful source/getting-started actions replace slogans, redundant metadata and the closing CTA section.
- [ ] Remove decorative uppercase labels. Preserve correct technical acronyms and product names.
- [ ] Use native Mintlify document typography; match Towbar's homepage hierarchy while preserving Mill's approved palette.
- [ ] Add native section cards and focused navigation scaled to Mill's supported workflows.
- [ ] Use consistent, readable titles and descriptions. Keep accurate technical detail in the guides where needed.
- [ ] Explain architecture, credential boundaries and operational commands with suitable native components and source links.
- [ ] Verify crisp current screenshots, both themes, desktop/mobile viewport bounds, wrapping, focus and links on the actual preview.
- [ ] Retain one maintained source for generated guides and offline docs.
- [ ] Obtain docs visual/copy approval separately from logo/palette approval; verify the final reviewed source before publication.

## Evidence locator

Dates above are UTC. Locators identify the originating turns in **Towbar: Implementation**.

| Feedback                             | Turn ID                                                                        |
| ------------------------------------ | ------------------------------------------------------------------------------ |
| Simplify homepage                    | `01a070dd-5909-7f50-95f9-9275cc3c0320`                                         |
| Hero/removed labels                  | `01a070ec-e5d5-7982-8bf0-4e797438b338`                                         |
| Header/search                        | `01a070f5-f3a9-7fe0-9e02-7ceefd830ed2`, `01a070fd-42c3-7720-a432-3570d202084d` |
| Copy approval/theme screenshots      | `01a070ff-4560-74a0-bc05-2bef7c685fea`                                         |
| Feature screenshots                  | `01a07119-7bc6-7382-99d4-a880fd0541da`                                         |
| Stale title/duplicate categories     | `01a07161-5173-7841-9ac4-d6b63919d576`, `01a071c4-5069-75e1-b223-481aabc864b3` |
| API/MCP reference                    | `01a07166-0f85-7762-b0ad-2b002bf08f80`                                         |
| README/single source                 | `01a0759d-9310-7181-93cd-e21bfd54187e`                                         |
| Numerical claim                      | `01a078a6-c224-7340-86c0-753950a60c6b`                                         |
| Optimize/refresh images              | `01a0855e-bf4b-72a3-9a37-f0c7321fc13c`, `01a08b84-6409-7b50-bab5-5b2e1bcb9a2a` |
| Crisp images/viewport/comparisons    | `01a0c8a9-dead-77b3-95ba-f32e4064fc13`                                         |
| Latest hero/CTA                      | `01a0c8ea-40ed-70b2-97fe-f116da06377a`                                         |
| CLI/native components                | `01a0c928-27d8-7d70-b7b1-6ad519830cd3`                                         |
| Cards/granular navigation            | `01a0c991-53f6-78c3-ae11-f701b8ed8ae9`, `01a0c99b-109b-71e1-aef3-35b377339b4b` |
| Remove preview/architecture          | `01a0c9d8-bc23-7990-a62b-577697d82216`, `01a0c9dd-b179-7011-82f7-3bde3462fb12` |
| Roles matrix                         | `01a0c9e7-bf71-7f22-8f4a-748bfa7fbdd2`                                         |
| Vercel/candid comparisons            | `01a0c9e9-418c-7e00-9f7f-75615cb9d3ff`, `01a0c9f0-f68c-7ff3-9cee-69f8c73f3e6a` |
| Highlighting/shared footer           | `01a0ca0c-0eb6-7ce1-9d8b-d2275c6d30f3`, `01a0ca10-4e3e-7651-bddf-c3a6e88216e1` |
| Obsolete secrets/current screenshots | `01a0dc18-8643-7601-b679-088ba2592e40`, `01a0de3a-03b6-7a73-943c-07fe327ec7a5` |

This review identifies rework. It does not claim that the rejected website has already been redesigned or published.
