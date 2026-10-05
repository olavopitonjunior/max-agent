import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

/**
 * O alerta de represados contra o Postgres real: a trava de um por dia mora
 * em `connection_state` e é atômica, e o envio que falha é retentado.
 */
const hasDb = Boolean(process.env.DATABASE_URL);
const d = hasDb ? describe : describe.skip;

vi.mock("../cm", async (orig) => ({
  ...(await orig<typeof import("../cm")>()),
  reportAlert: vi.fn().mockResolvedValue(true),
}));

const { alertarRepresados } = await import("../alerta-represados");
const { reportAlert } = await import("../cm");
const { query } = await import("../db");
const report = reportAlert as unknown as ReturnType<typeof vi.fn>;

const ORG = "org-represados";
let seq = 0;

async function represado(horas: number) {
  seq += 1;
  await query(
    `INSERT INTO outbox (id, org_id, dedupe_key, audience, phone, recipient_name, title, body,
                         status, last_error, created_at)
     VALUES ($1, $2, $1, 'platform_user', '5511900007777', 'Ana', 'Aviso', 'corpo',
             'pending', 'template_pendente: sem template aprovado', now() - ($3 || ' hours')::interval)`,
    [`rep-${seq}-${Date.now()}`, ORG, String(horas)]
  );
}

d("alertarRepresados (Postgres real)", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    report.mockResolvedValue(true);
    await query(`DELETE FROM outbox WHERE org_id = $1`, [ORG]);
    // A contagem é global: represados/expirados de outras suítes atrapalhariam.
    await query(
      `DELETE FROM outbox WHERE (status = 'pending' AND last_error LIKE 'template_pendente:%')
                              OR (status = 'dropped' AND last_error LIKE 'expirado:%')`
    );
    await query(
      `INSERT INTO connection_state (id, connected) VALUES (true, true)
       ON CONFLICT (id) DO UPDATE SET represados_notified_at = NULL`
    );
  });
  afterAll(async () => {
    await query(`DELETE FROM outbox WHERE org_id = $1`, [ORG]);
    await query(`UPDATE connection_state SET represados_notified_at = NULL WHERE id`);
  });

  it("represado há mais de 24h: um alerta com quantos e desde quando", async () => {
    await represado(30);
    await represado(50);
    await represado(2); // recente: não conta
    expect(await alertarRepresados()).toBe(true);
    expect(report).toHaveBeenCalledTimes(1);
    const arg = report.mock.calls[0][0];
    expect(arg).toMatchObject({ evento: "avisos_represados", represadas: 2, canal: "meta" });
    const idadeMs = Date.now() - Date.parse(arg.maisAntigo);
    expect(idadeMs).toBeGreaterThan(49 * 3_600_000);
  });

  it("só represados recentes: nada", async () => {
    await represado(5);
    expect(await alertarRepresados()).toBe(false);
    expect(report).not.toHaveBeenCalled();
  });

  it("no máximo um por dia: a segunda passada não manda", async () => {
    await represado(30);
    expect(await alertarRepresados()).toBe(true);
    expect(await alertarRepresados()).toBe(false);
    expect(report).toHaveBeenCalledTimes(1);
  });

  it("depois de 24h do último, manda de novo", async () => {
    await represado(30);
    await alertarRepresados();
    await query(`UPDATE connection_state SET represados_notified_at = now() - interval '25 hours' WHERE id`);
    expect(await alertarRepresados()).toBe(true);
    expect(report).toHaveBeenCalledTimes(2);
  });

  it("envio que falha recua a trava ~1h: não repete no minuto seguinte, e tenta de novo depois de 1h", async () => {
    await represado(30);
    report.mockResolvedValueOnce(false);
    expect(await alertarRepresados()).toBe(false);
    expect(await alertarRepresados()).toBe(false);
    expect(report).toHaveBeenCalledTimes(1);
    const [c] = await query<{ h: number }>(
      `SELECT extract(epoch FROM now() - represados_notified_at) / 3600 AS h FROM connection_state WHERE id`
    );
    expect(Number(c.h)).toBeGreaterThan(22.9);
    expect(Number(c.h)).toBeLessThan(23.1);
    await query(`UPDATE connection_state SET represados_notified_at = now() - interval '24 hours 1 minute' WHERE id`);
    expect(await alertarRepresados()).toBe(true);
    expect(report).toHaveBeenCalledTimes(2);
  });

  it("falha não sobrescreve uma trava mais nova de outra passada", async () => {
    await represado(30);
    report.mockImplementationOnce(async () => {
      // Outra passada tomou e carimbou enquanto este POST estava no ar.
      await query(`UPDATE connection_state SET represados_notified_at = now() + interval '1 second' WHERE id`);
      return false;
    });
    await alertarRepresados();
    const [c] = await query<{ futuro: boolean }>(
      `SELECT represados_notified_at > now() AS futuro FROM connection_state WHERE id`
    );
    expect(c.futuro).toBe(true);
  });

  it("sem tempo para o POST, nem tenta (e não toma a trava)", async () => {
    await represado(30);
    expect(await alertarRepresados(10_000)).toBe(false);
    expect(report).not.toHaveBeenCalled();
    expect(await alertarRepresados()).toBe(true);
  });

  it("leva quantos expiraram nos últimos 7 dias", async () => {
    await represado(30);
    await query(
      `INSERT INTO outbox (id, org_id, dedupe_key, audience, phone, recipient_name, title, body,
                           status, last_error, last_attempt_at)
       VALUES ('exp-1', $1, 'exp-1', 'platform_user', '5511900007777', 'Ana', 'x', 'x',
               'dropped', 'expirado: 72h sem template', now() - interval '1 day')`,
      [ORG]
    );
    await alertarRepresados();
    expect(report.mock.calls[0][0].expirados).toBe(1);
  });

  it("duas passadas simultâneas mandam UM alerta", async () => {
    await represado(30);
    const [a, b] = await Promise.all([alertarRepresados(), alertarRepresados()]);
    expect([a, b].filter((x) => x === true)).toHaveLength(1);
    expect(report).toHaveBeenCalledTimes(1);
  });
});
