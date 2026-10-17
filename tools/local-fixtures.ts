import { createHash, randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import { sql, closeDatabase } from "../packages/database/src/index.js";
import { hashPassword } from "../apps/api/src/auth/security.js";

export function assertLocalFixtureEnvironment(env: NodeJS.ProcessEnv) {
  if (env.NODE_ENV === "production")
    throw new Error("Local fixtures cannot run in production.");
  for (const key of ["DATABASE_URL", "MILL_WEB_URL", "MILL_API_URL"]) {
    const value = env[key];
    if (!value) throw new Error(`${key} is required for local fixtures.`);
    const url = new URL(value);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
      throw new Error(`${key} must use a loopback host for local fixtures.`);
  }
}

function fixtureId(workspaceId: string, key: string) {
  const hex = createHash("sha256")
    .update(`mill:local-fixtures:v1:${workspaceId}:${key}`)
    .digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

const boards = [
  {
    name: "Product",
    prefix: "PRD",
    description: "Plan product improvements and review the next release.",
    titles: [
      "Simplify the first board experience",
      "Fix task title truncation on small screens",
      "Review the task creation flow",
      "Add examples to the getting started guide",
      "Improve keyboard navigation in filters",
      "Clarify empty state instructions",
      "Review notification preferences",
      "Preserve filters when returning from a task",
      "Improve the overdue date treatment",
      "Review the mobile task detail layout",
      "Prepare the next release notes",
      "Fix a duplicate notification after retry",
      "Audit light and dark theme contrast",
      "Review the board settings copy",
      "Make long descriptions easier to read",
      "Check the task duplication flow",
      "Update the account settings guide",
      "Improve member search results",
      "Review date and time preferences",
      "Fix focus after closing a dialog",
      "Test task assignment notifications",
      "Review permissions for viewers",
      "Polish the board overview counts",
      "Document the supported Markdown syntax",
      "Check pagination with active filters",
      "Improve task type descriptions",
      "Review the invitation experience",
      "Tighten spacing in the activity list",
      "Prepare a usability review",
      "Explore custom task status colors",
    ],
  },
  {
    name: "Engineering",
    prefix: "ENG",
    description:
      "Track reliability, API improvements and developer experience.",
    titles: [
      "Verify database backup and restore",
      "Fix stale task versions after reconnecting",
      "Review API pagination limits",
      "Update dependency versions",
      "Check concurrent task edits",
      "Document local development commands",
      "Verify credential revocation",
      "Review container health checks",
    ],
  },
  {
    name: "Website",
    prefix: "WEB",
    description: "Maintain the product website and public documentation.",
    titles: [
      "Refresh the homepage screenshots",
      "Fix the documentation navigation on mobile",
      "Review installation instructions",
      "Write the task attachments guide",
      "Check social sharing previews",
      "Remove an outdated announcement",
    ],
  },
  {
    name: "Ideas",
    prefix: "IDEA",
    description: "An empty board for trying the first task experience.",
    titles: [],
  },
];

export async function seedLocalFixtures(adminEmail: string) {
  assertLocalFixtureEnvironment(process.env);
  const passwordHash = await hashPassword(
    randomBytes(32).toString("base64url"),
  );
  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(78127002)`;
    const [admin] = await tx`
      SELECT id,workspace_id,name FROM users
      WHERE email=${adminEmail.trim().toLowerCase()} AND role='admin' AND disabled_at IS NULL`;
    if (!admin)
      throw new Error(
        "Complete setup first and choose an active administrator with --admin-email.",
      );
    const counts = {
      boards: 0,
      tasks: 0,
      people: 0,
      comments: 0,
      notifications: 0,
    };
    const people: { id: string; name: string }[] = [];
    for (const [name, email, role] of [
      ["Maya Chen", "maya@example.test", "member"],
      ["Alex Morgan", "alex@example.test", "member"],
      ["Sam Rivera", "sam@example.test", "viewer"],
    ]) {
      const inserted = await tx`
        INSERT INTO users(id,workspace_id,name,email,password_hash,role,email_verified,time_zone)
        VALUES(${fixtureId(admin.workspaceId, email)},${admin.workspaceId},${name},${email},${passwordHash},${role},true,${"Asia/Kolkata"})
        ON CONFLICT(email) DO NOTHING RETURNING id`;
      counts.people += inserted.length;
      const [person] =
        await tx`SELECT id,name FROM users WHERE email=${email} AND workspace_id=${admin.workspaceId} AND disabled_at IS NULL`;
      if (!person)
        throw new Error(`The sample member ${email} is unavailable.`);
      people.push({ id: person.id, name: person.name });
    }
    const today = new Date();
    function date(offset: number) {
      const value = new Date(today);
      value.setUTCDate(value.getUTCDate() + offset);
      return value.toISOString().slice(0, 10);
    }
    const statuses = [
      "in_progress",
      "todo",
      "backlog",
      "in_review",
      "done",
      "wont_do",
    ];
    const priorities = ["high", "urgent", "medium", "low", "none"];
    for (const board of boards) {
      const boardId = fixtureId(admin.workspaceId, board.prefix);
      const inserted = await tx`
        INSERT INTO boards(id,workspace_id,name,prefix,description,next_number,created_by_user_id,created_by_name,created_by_kind)
        VALUES(${boardId},${admin.workspaceId},${board.name},${board.prefix},${board.description},${board.titles.length + 1},${admin.id},${admin.name},'human')
        ON CONFLICT(id) DO NOTHING RETURNING id`;
      await tx`UPDATE boards SET created_by_user_id=${admin.id},created_by_name=${admin.name},created_by_kind='human'
        WHERE id=${boardId} AND created_by_kind IS NULL`;
      if (!inserted.length) continue;
      counts.boards++;
      for (const [index, title] of board.titles.entries()) {
        const taskId = fixtureId(admin.workspaceId, `${board.prefix}:${index}`);
        const identifier = `${board.prefix}-${index + 1}`;
        const status = statuses[index % statuses.length];
        const type = index % 6 === 1 ? "bug" : "task";
        const assigneeId = [admin.id, people[0].id, people[1].id, null][
          index % 4
        ];
        const description = `## ${title}\n\nReview this item with the team before the next release.\n\nThese are sample records for local development.`;
        const acceptanceCriteria =
          "- Check desktop and mobile behavior\n- Verify keyboard navigation and both themes\n- Add the outcome to the discussion";
        const createdAt = new Date(today.getTime() - (index + 1) * 3600000);
        await tx`
          INSERT INTO tasks(id,board_id,type,status,identifier,title,description,acceptance_criteria,assignee_id,priority,start_date,due_date,created_by,created_at,updated_at,status_changed_at)
          VALUES(${taskId},${boardId},${type},${status},${identifier},${title},${description},${acceptanceCriteria},${assigneeId},${priorities[index % priorities.length]},${index % 3 === 0 ? date(-3) : null},${index % 4 === 3 ? null : date((index % 9) - 2)},${people[0].id},${createdAt},${createdAt},${today})`;
        await tx`
          INSERT INTO activity(task_id,board_id,actor_id,actor_name,actor_kind,action,detail,created_at)
          VALUES(${taskId},${boardId},${people[0].id},${people[0].name},'human','task.created',${tx.json({ title, identifier, type })},${createdAt})`;
        counts.tasks++;
        if (index < 2) {
          const body =
            index === 0
              ? `The first review is ready. @${adminEmail}, could you check the desktop and mobile experience?`
              : "I reproduced this on a narrow screen. The next step is to check focus and scrolling after the fix.";
          await tx`
            INSERT INTO comments(task_id,author_id,body)
            VALUES(${taskId},${people[1].id},${body})`;
          counts.comments++;
          if (index === 0) {
            await tx`
              INSERT INTO notifications(user_id,task_id,kind,actor_name)
              VALUES(${admin.id},${taskId},'mention',${people[1].name})`;
            counts.notifications++;
          }
        }
      }
    }
    return counts;
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 2 || args[0] !== "--admin-email")
      throw new Error("Usage: pnpm fixtures --admin-email you@example.test");
    console.log("Added local fixtures:", await seedLocalFixtures(args[1]));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  } finally {
    await closeDatabase();
  }
}
