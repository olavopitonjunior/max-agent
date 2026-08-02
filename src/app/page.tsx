/**
 * O Max não tem UI própria: o Mission Control dele vive no admin do ImobPro,
 * que consome `GET /api/admin/status`. Esta página existe só para o domínio
 * não devolver 404 a quem abrir no navegador.
 */
export default function Home() {
  return (
    <main style={{ fontFamily: "system-ui", padding: 40 }}>
      <h1>Max Agent</h1>
      <p>Serviço de WhatsApp dos tenants RE/MAX do ImobPro.</p>
      <p>Painel: admin do ImobPro → Agentes → Max.</p>
    </main>
  );
}
