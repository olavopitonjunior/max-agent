import { describe, expect, it } from "vitest";
import { destinoPermitido, ehIdDeOutbox } from "../redirect";

describe("destinoPermitido — anti open-redirect", () => {
  it.each([
    "https://imobpro.ia.br/deals/x",
    "https://trio.imobpro.ia.br/deals/x?tab=1",
    "https://staging.imobpro.ia.br/pay/abc",
    "http://imobpro.ia.br/f/tok",
    "https://IMOBPRO.IA.BR/deals/x",
  ])("aceita %s", (link) => {
    expect(destinoPermitido(link)).not.toBeNull();
  });

  it.each([
    ["domínio que só CONTÉM o nosso", "https://imobpro.ia.br.evil.com/x"],
    ["sufixo sem ponto", "https://evilimobpro.ia.br/x"],
    ["usuário no link", "https://imobpro.ia.br@evil.com/x"],
    ["userinfo com o nosso host", "https://user:pw@imobpro.ia.br/x"],
    ["porta", "https://imobpro.ia.br:8443/x"],
    ["javascript:", "javascript:alert(1)"],
    ["data:", "data:text/html,<script>alert(1)</script>"],
    ["protocolo relativo", "//evil.com/x"],
    ["caminho relativo", "/deals/x"],
    ["outro domínio", "https://evil.com/?q=imobpro.ia.br"],
    ["vazio", ""],
  ])("recusa %s", (_desc, link) => {
    expect(destinoPermitido(link)).toBeNull();
  });

  it("nulo e indefinido são recusados", () => {
    expect(destinoPermitido(null)).toBeNull();
    expect(destinoPermitido(undefined)).toBeNull();
  });
});

describe("ehIdDeOutbox", () => {
  it("só UUID", () => {
    expect(ehIdDeOutbox("3f2b8c1e-9a4d-4e2f-8b1a-2c3d4e5f6a7b")).toBe(true);
    expect(ehIdDeOutbox("1")).toBe(false);
    expect(ehIdDeOutbox("' OR 1=1 --")).toBe(false);
    expect(ehIdDeOutbox("3f2b8c1e-9a4d-4e2f-8b1a-2c3d4e5f6a7b/../x")).toBe(false);
  });
});
