const express = require('express');
const axios = require('axios');
const { Pool } = require('pg');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors({ origin: '*' }));

// --- SUAS CONFIGURAÇÕES ---
const CONFIG = {
    // ⬇️ COLOQUE SUA CHAVE AQUI DENTRO DAS ASPAS SE NÃO USAR O RAILWAY VARIABLES
    API_KEY: process.env.API_FOOTBALL_KEY || "SUA_CHAVE_AQUI", 
    
    LUCRO_CASA: 0.88, // Margem da banca
    TEMPO_CACHE_MINUTOS: 30, // Atualiza a cada 30min para não estourar o limite grátis
    MIN_VALOR: 2.00,
    MAX_VALOR: 1000.00
};

// Times Fortes (Para o motor de odds saber quem é favorito)
const TIMES_FORTES = ["Flamengo", "Palmeiras", "Atlético-MG", "Real Madrid", "Barcelona", "Man City", "Liverpool", "PSG", "Bayern", "Inter", "Arsenal", "Botafogo", "São Paulo", "Corinthians", "Grêmio", "Boca Juniors", "River Plate", "Juventus", "Milan"];

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function initDb() {
    try {
        await pool.query(`CREATE TABLE IF NOT EXISTS usuarios (id SERIAL PRIMARY KEY, nome TEXT, email TEXT UNIQUE, senha TEXT, saldo NUMERIC DEFAULT 0.00)`);
        await pool.query(`CREATE TABLE IF NOT EXISTS bilhetes (id SERIAL PRIMARY KEY, usuario_id INTEGER, codigo TEXT UNIQUE, valor NUMERIC, retorno NUMERIC, odds_total NUMERIC, status TEXT DEFAULT 'pendente', detalhes JSONB, data TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
        
        // Tabela de Cache para economizar API
        await pool.query(`CREATE TABLE IF NOT EXISTS jogos_cache (id SERIAL PRIMARY KEY, data_ref TEXT UNIQUE, json_dados JSONB, atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
        
        console.log("✅ Servidor V33 (API Oficial Free) Online!");
    } catch (e) { console.error("Erro DB:", e.message); }
}
initDb();

// --- ROTA DE JOGOS (COM ECONOMIA DE API) ---
app.get('/api/jogos', async (req, res) => {
    const dataHoje = req.query.data || new Date().toISOString().split('T')[0];
    
    try {
        // 1. Verifica se tem cache recente no banco (Menos de 30 min)
        const cache = await pool.query("SELECT json_dados, atualizado_em FROM jogos_cache WHERE data_ref = $1", [dataHoje]);
        
        if (cache.rows.length > 0) {
            const ultimaAtualizacao = new Date(cache.rows[0].atualizado_em);
            const agora = new Date();
            const diferencaMinutos = (agora - ultimaAtualizacao) / 1000 / 60;

            if (diferencaMinutos < CONFIG.TEMPO_CACHE_MINUTOS) {
                console.log("📦 Usando Cache (Economizando API)...");
                return res.json(cache.rows[0].json_dados);
            }
        }

        // 2. Se o cache for velho ou não existir, VAI NA API OFICIAL
        console.log("🌍 INDO NA API OFICIAL (Gastando 1 crédito)...");
        
        const url = `https://v3.football.api-sports.io/fixtures?date=${dataHoje}&status=NS-1H-2H-HT-FT`; // Pega Jogos Não Iniciados e Ao Vivo
        const resp = await axios.get(url, { 
            headers: { 
                'x-apisports-key': CONFIG.API_KEY,
                'x-rapidapi-host': 'v3.football.api-sports.io'
            },
            timeout: 8000 
        });

        if (resp.data.errors && Object.keys(resp.data.errors).length > 0) {
            console.error("❌ ERRO API:", JSON.stringify(resp.data.errors));
            // Se der erro de limite, tenta usar o que tem no cache mesmo velho
            if (cache.rows.length > 0) return res.json(cache.rows[0].json_dados);
            throw new Error("Limite da API excedido ou Chave Inválida");
        }

        let jogos = [];
        if (resp.data.response) {
            // Formata usando o Motor Híbrido (Nomes Reais + Odds Calculadas)
            // Por que Odds Calculadas? Porque a API Free não libera odds detalhadas de todos os jogos
            // e fazer chamada de odds gasta muito limite.
            jogos = formatarAPIOficial(resp.data.response);
        }

        // 3. Salva no Banco com horário atual
        if (jogos.length > 0) {
            await pool.query(`INSERT INTO jogos_cache (data_ref, json_dados, atualizado_em) 
                VALUES ($1, $2, NOW()) 
                ON CONFLICT (data_ref) 
                DO UPDATE SET json_dados = $2, atualizado_em = NOW()`, [dataHoje, JSON.stringify(jogos)]);
        }
        
        res.json(jogos);

    } catch (e) {
        console.error("Erro Geral:", e.message);
        // Fallback: Se tudo der errado, manda lista vazia ou cache antigo se tiver
        res.json([]); 
    }
});

// --- ROTA FINALIZAR ---
app.post('/api/finalizar', async (req, res) => {
    try {
        let { usuario_id, valor, apostas, odd_total } = req.body;
        const codigo = "GB" + Math.floor(100000 + Math.random() * 900000);
        const retorno = (parseFloat(valor) * parseFloat(odd_total)).toFixed(2);
        
        await pool.query('INSERT INTO bilhetes (usuario_id, codigo, valor, retorno, odds_total, detalhes) VALUES ($1, $2, $3, $4, $5, $6)', 
            [usuario_id || 1, codigo, valor, retorno, odd_total, JSON.stringify(apostas)]);
            
        res.json({ sucesso: true, codigo, retorno });
    } catch (e) { res.status(500).json({ erro: "Erro ao processar bilhete" }); }
});

// --- FORMATADORES & MOTOR DE ODDS ---
function formatarAPIOficial(lista) {
    // Filtra ligas principais para não poluir o site com "3ª Divisão da Indonésia"
    // Se quiser tudo, remova o filtro.
    const LIGAS_PERMITIDAS = ["Brasileirão", "Serie A", "Premier League", "La Liga", "Bundesliga", "Ligue 1", "Primeira Liga", "Copa", "Libertadores", "Sudamericana", "Champions League", "Serie B", "Paulista", "Carioca", "Mineiro", "Gaucho"];
    
    return lista.map(j => {
        try {
            const ligaNome = j.league.name;
            const pais = j.league.country;
            
            // Filtro Opcional: Só mostra se for liga famosa ou do Brasil
            // if (!LIGAS_PERMITIDAS.some(l => ligaNome.includes(l) || pais === "Brazil")) return null;

            const oddsBase = calcularOddsBase(j.teams.home.name, j.teams.away.name);

            return {
                id: j.fixture.id,
                liga: (pais === "World" ? ligaNome : `${pais} - ${ligaNome}`).toUpperCase(),
                home: { name: j.teams.home.name, logo: j.teams.home.logo },
                away: { name: j.teams.away.name, logo: j.teams.away.logo },
                data: j.fixture.date,
                status: traduzirStatus(j.fixture.status.short),
                odds: oddsBase,
                mercados: gerarMercadosExtras(oddsBase) // Gera o cardápio completo (Gols, Handicap, etc)
            };
        } catch (e) { return null; }
    }).filter(Boolean);
}

function traduzirStatus(st) {
    if(st === 'NS') return 'VS';
    if(['1H','2H','HT','ET','P'].includes(st)) return 'AO VIVO';
    if(st === 'FT') return 'ENC';
    return st;
}

function calcularOddsBase(home, away) {
    // Motor Matemático V31 (Mantido porque é excelente)
    const hStrong = TIMES_FORTES.some(t => home.includes(t));
    const aStrong = TIMES_FORTES.some(t => away.includes(t));
    let c = 2.40, e = 3.20, f = 2.80;

    if (hStrong && !aStrong) { c = 1.45; e = 4.20; f = 6.50; }
    else if (aStrong && !hStrong) { c = 5.50; e = 3.90; f = 1.55; }
    
    // Pequena variação aleatória para não parecer robô
    c += (Math.random() * 0.2); f += (Math.random() * 0.2);
    
    return { casa: aplicarMargem(c), empate: aplicarMargem(e), fora: aplicarMargem(f) };
}

function aplicarMargem(v) { return (parseFloat(v) * CONFIG.LUCRO_CASA).toFixed(2); }

function gerarMercadosExtras(base) {
    const C = parseFloat(base.casa);
    const m = CONFIG.LUCRO_CASA;
    const calc = (v) => (v * m).toFixed(2);
    // Gera mercados baseados na probabilidade da Odd Principal
    return {
        dupla_chance: { "1X": calc(1.25), "12": calc(1.30), "X2": calc(1.25) },
        empate_anula: { "1": calc(C * 0.75), "2": calc(parseFloat(base.fora) * 0.75) },
        ambas_marcam: { "Sim": calc(1.85), "Não": calc(1.95) },
        total_gols: { "Mais 1.5": calc(1.28), "Menos 1.5": calc(3.50), "Mais 2.5": calc(1.90), "Menos 2.5": calc(1.90) },
        ht_vencedor: { "1": calc(C + 1.2), "X": calc(2.05), "2": calc(parseFloat(base.fora) + 1.2) },
        ft_vencedor_2tempo: { "1": calc(C + 0.6), "X": calc(2.40), "2": calc(parseFloat(base.fora) + 0.6) },
        placar_exato: { "1-0": calc(C * 3.5), "2-0": calc(C * 4.5), "2-1": calc(C * 6.0), "0-1": calc(parseFloat(base.fora) * 3.5) },
        handicap: { "Casa -1": calc(C * 2.8), "Fora +1": calc(1.45) }
    };
}

// Rotas Padrão
app.get('/api/admin/resumo', async (req, res) => { try { const f = await pool.query(`SELECT COUNT(*) as t, SUM(valor) as e, SUM(retorno) as r FROM bilhetes`); const u = await pool.query(`SELECT codigo, valor, retorno, data FROM bilhetes ORDER BY data DESC LIMIT 10`); res.json({ caixa: { total: f.rows[0].t, entrada: `R$ ${parseFloat(f.rows[0].e||0).toFixed(2)}`, risco: `R$ ${parseFloat(f.rows[0].r||0).toFixed(2)}` }, ultimos: u.rows }); } catch (e) { res.status(500).json({ erro: "Erro" }); } });
app.post('/api/cadastro', async (req, res) => { try { const { nome, email, senha } = req.body; const result = await pool.query('INSERT INTO usuarios (nome, email, senha) VALUES ($1, $2, $3) RETURNING id, nome, saldo', [nome, email, "123"]); res.json({ sucesso: true, usuario: result.rows[0] }); } catch (e) { res.status(500).json({ erro: "Erro" }); } });
app.post('/api/login', async (req, res) => { try { const { email, senha } = req.body; const r = await pool.query('SELECT * FROM usuarios WHERE email = $1', [email]); if(r.rows.length) { res.json({sucesso:true, usuario:r.rows[0]}); } else res.status(400).json({erro:"Erro"}); } catch(e){ res.status(500).json({erro:"Erro"}); } });
app.listen(process.env.PORT || 3000, () => console.log("🔥 Server V33 (API Oficial) On!"));
