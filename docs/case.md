# Case Summary - api-demo

## Contexto

Este projeto foi estruturado para simular um backend de matrícula com checkout, priorizando padrões de produção: confiabilidade, segurança e observabilidade operacional.

## Problema técnico

Em fluxos de pagamento, retries de rede podem gerar duplicidade de cobrança e inconsistência de estado se a API não for idempotente e transacionalmente cuidadosa.

## Objetivos de engenharia

- Garantir comportamento determinístico em retries.
- Persistir trilha operacional de cada tentativa de checkout.
- Isolar endpoint interno com autenticação robusta.
- Suportar evolução de schema sem quebrar ambientes legados.

## Decisões implementadas

- `Idempotency-Key` explícita + chave automática determinística.
- Fallback por `reference` quando coluna idempotente ainda não existe.
- Atualização de `payment_checkouts` e `lead_enrollments` em ciclo completo.
- Provider desacoplado por modo (`mock` para demo, `rede` para real).
- Comparação segura de token (`timingSafeEqual`) e suporte a hash SHA-256.

## Valor para portfólio

O repositório demonstra ownership de backend em fluxo sensível:
- integridade de cobrança,
- segurança de dados,
- clareza para operação,
- documentação executável para validação rápida.
