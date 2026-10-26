/** Versioned isolation contract. Legacy deployments must return 404, never run a live turn. */
export { GET, POST } from "../route";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;
