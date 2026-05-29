-- GIN trigram index for fuzzy product search
CREATE INDEX IF NOT EXISTS produtos_nome_trgm_idx
  ON produtos_catalogo USING gin (nome_normalizado gin_trgm_ops);

-- Product search with PT-BR scoring
-- exact=100, prefix=50, contains=30, trigram=20, +40 if available
CREATE OR REPLACE FUNCTION buscar_produtos(
  p_account_id UUID,
  p_consulta TEXT,
  p_limit INT DEFAULT 15
)
RETURNS TABLE (
  id UUID,
  bling_id VARCHAR,
  nome VARCHAR,
  codigo VARCHAR,
  preco NUMERIC,
  preco_promocional NUMERIC,
  estoque INT,
  disponivel BOOLEAN,
  descricao_curta TEXT,
  imagem_bling TEXT,
  imagem_cloudinary TEXT,
  marca VARCHAR,
  categoria VARCHAR,
  score INT
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_consulta_norm TEXT;
BEGIN
  v_consulta_norm := lower(unaccent(trim(p_consulta)));

  RETURN QUERY
  SELECT
    p.id,
    p.bling_id,
    p.nome,
    p.codigo,
    p.preco,
    p.preco_promocional,
    p.estoque,
    p.disponivel,
    p.descricao_curta,
    p.imagem_bling,
    p.imagem_cloudinary,
    p.marca,
    p.categoria,
    (
      CASE
        WHEN p.nome_normalizado = v_consulta_norm THEN 100
        WHEN p.nome_normalizado LIKE v_consulta_norm || '%' THEN 50
        WHEN p.nome_normalizado LIKE '%' || v_consulta_norm || '%' THEN 30
        WHEN p.nome_normalizado % v_consulta_norm THEN 20
        ELSE 0
      END
      + CASE WHEN p.disponivel THEN 40 ELSE 0 END
    )::INT AS score
  FROM produtos_catalogo p
  WHERE p.account_id = p_account_id
    AND (
      p.nome_normalizado LIKE '%' || v_consulta_norm || '%'
      OR p.nome_normalizado % v_consulta_norm
      OR p.codigo ILIKE '%' || p_consulta || '%'
    )
  ORDER BY score DESC, p.nome ASC
  LIMIT p_limit;
END;
$$;
