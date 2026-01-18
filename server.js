const express = require('express');
const axios = require('axios');
const { Pool } = require('pg');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors({ origin: '*' }));

const CONFIG = {
    API_KEY: process.env.API_FOOTBALL_KEY || "SUA_CHAVE_AQUI", 
    LUCRO_CASA: 0.90, // Margem da Casa
    TEMPO_CACHE_MINUTOS: 20, 
    MIN_VALOR: 2.00,
    MAX_VALOR: 1000.00,
    MAX_PREMIO: 10000.00,
    LIGAS_VIP: ["Premier League", "La Liga", "Serie A", "Brasileirão", "Paulista", "Carioca", "Champions League", "Libertadores"]
};

// TRADUÇÕES
const TRADUCOES = { "World": "Mundo", "Brazil": "Brasil", "England": "Inglaterra", "Spain": "Espanha", "Italy": "Itália", "Germany": "Alemanha", "France": "França", "Portugal": "Portugal", "Premier League": "Premier League", "Serie A": "Série A", "La Liga": "La Liga", "Carioca - 1": "Carioca", "Paulista - A1": "Paulista A1", "Copa Libertadores": "Libertadores", "UEFA Champions League": "Champions League" };
function traduzir(txt) { return TRADUCOES[txt] || txt; }

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function initDb() {
    try {
        await pool.query(`CREATE TABLE IF NOT EXISTS bilhetes (id SERIAL PRIMARY KEY, usuario_id INTEGER, codigo TEXT UNIQUE, valor NUMERIC, retorno NUMERIC, odds_total NUMERIC, status TEXT DEFAULT 'pendente', detalhes JSONB, data TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
        await pool.query(`CREATE TABLE IF NOT EXISTS jogos_cache (id SERIAL PRIMARY KEY, data_ref TEXT UNIQUE, json_dados JSONB, atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
        await pool.query("DELETE FROM jogos_cache"); // Limpa tudo pra garantir atualização
        console.log("✅ Servidor V56 (Variedade + Correção 1.67) Online!");
    } catch (e) { console.error(e); }
}
initDb();

app.get('/api/jogos', async (req, res) => {
    const dataHoje = req.query.data || new Date().toISOString().split('T')[0];
    try {
        // Tenta pegar do cache primeiro
        const cache = await pool.query("SELECT json_dados, atualizado_em FROM jogos_cache WHERE data_ref = $1", [dataHoje]);
        if (cache.rows.length > 0) {
            const diff = (new Date() - new Date(cache.rows[0].atualizado_em)) / 1000 / 60;
            if (diff < CONFIG.TEMPO_CACHE_MINUTOS) return res.json(cache.rows[0].json_dados);
        }
        
        console.log("🌍 Buscando API (V56)...");
        const headers = { 'x-apisports-key': CONFIG.API_KEY };

        // 1. Busca Jogos
        const respJogos = await axios.get(`https://v3.football.api-sports.io/fixtures?date=${dataHoje}&timezone=America/Sao_Paulo`, { headers });
        const listaBruta = respJogos.data.response || [];

        // 2. Busca Odds Reais (Tentativa)
        let mapaOdds = {};
        try {
            const respOdds = await axios.get(`https://v3.football.api-sports.io/odds?date=${dataHoje}&bookmaker=6&timezone=America/Sao_Paulo`, { headers });
            if(respOdds.data.response) {
                respOdds.data.response.forEach(o => { mapaOdds[o.fixture.id] = o.bookmakers[0].bets; });
            }
        } catch (e) { console.log("⚠️ API Odds falhou ou limitou. Usando simulador inteligente."); }

        // Formata os jogos (Aqui acontece a mágica)
        let jogosFinais = formatarV56(listaBruta, mapaOdds);
        
        if (jogosFinais.length > 0) {
            await pool.query(`INSERT INTO jogos_cache (data_ref, json_dados, atualizado_em) VALUES ($1, $2, NOW()) ON CONFLICT (data_ref) DO UPDATE SET json_dados = $2, atualizado_em = NOW()`, [dataHoje, JSON.stringify(jogosFinais)]);
        }
        res.json(jogosFinais);
    } catch (e) { res.json([]); }
});

function formatarV56(listaJogos, mapaOdds) {
    return listaJogos.map(j => {
        try {
            const st = j.fixture.status.short;
            if (['FT', 'AET', 'PEN', '1H', '2H', 'HT'].includes(st)) return null;

            const oddsReais = mapaOdds[j.fixture.id]; 
            let oddsBase;

            if (oddsReais) {
                // Tenta usar odd real da Bet365
                const winner = oddsReais.find(b => b.id === 1);
                if (winner) {
                    oddsBase = {
                        casa: parseFloat(winner.values.find(v=>v.value==='Home').odd),
                        empate: parseFloat(winner.values.find(v=>v.value==='Draw').odd),
                        fora: parseFloat(winner.values.find(v=>v.value==='Away').odd)
                    };
                } else {
                    // Sem vencedor definido, simula com variedade
                    oddsBase = gerarOddUnica(j.teams.home.name, j.teams.away.name);
                }
            } else {
                // Sem odd nenhuma, simula com variedade
                oddsBase = gerarOddUnica(j.teams.home.name, j.teams.away.name);
            }

            // Aplica margem do site (0.90)
            const oddsFinais = {
                casa: (oddsBase.casa * CONFIG.LUCRO_CASA).toFixed(2),
                empate: (oddsBase.empate * CONFIG.LUCRO_CASA).toFixed(2),
                fora: (oddsBase.fora * CONFIG.LUCRO_CASA).toFixed(2)
            };
            
            // Gera mercados matematicamente (sem repetir 1.67)
            const mercadosCalculados = gerarMercadosMatematicos(oddsBase);

            const ligaNome = `${traduzir(j.league.country)} - ${traduzir(j.league.name)}`.toUpperCase();
            return {
                id: j.fixture.id,
                liga: ligaNome,
                flag: j.league.flag || "https://cdn-icons-png.flaticon.com/512/53/53280.png",
                home: { name: j.teams.home.name, logo: j.teams.home.logo },
                away: { name: j.teams.away.name, logo: j.teams.away.logo },
                data: j.fixture.date,
                status: "VS",
                odds: oddsFinais,
                mercados: mercadosCalculados
            };
        } catch (e) { return null; }
    }).filter(Boolean);
}

// --- GERADOR DE ODDS ÚNICAS (FIM DA REPETIÇÃO) ---
function gerarOddUnica(home, away) {
    // Cria um número "DNA" baseado no nome dos times.
    // Isso garante que Bangu x Madureira seja diferente de Fla x Flu.
    let seed = 0;
    const combo = home + away;
    for(let i=0; i<combo.length; i++) seed += combo.charCodeAt(i);
    
    // Variação leve para não ficar tudo igual (2.30 a 2.60 para casa)
    const varCasa = (seed % 30) / 100; // 0.00 a 0.29
    const varFora = (seed % 20) / 100; // 0.00 a 0.19

    return { 
        casa: 2.30 + varCasa,  // Ex: 2.45
        empate: 3.10 + varFora, // Ex: 3.15
        fora: 2.70 + (0.30 - varCasa) // Ex: 2.80 (Equilibra a conta)
    };
}

// --- MATEMÁTICA PURA (FIM DO 1.67 IGUAL) ---
function gerarMercadosMatematicos(base) {
    const margem = CONFIG.LUCRO_CASA;
    const fx = (v) => (v * margem).toFixed(2);
    
    const C = base.casa;
    const E = base.empate;
    const F = base.fora;

    // 1. Chance Dupla (Matemática Real)
    // 1/Probabilidade
    const probC = 1/C; const probE = 1/E; const probF = 1/F;
    const dc1X = 1 / (probC + probE);
    const dc12 = 1 / (probC + probF);
    const dcX2 = 1 / (probE + probF);

    // 2. Ambas Marcam (Dinâmico)
    // Se o jogo é muito fechado (Empate baixo), BTTS é difícil (Odd Alta)
    // Se o jogo é aberto, BTTS é fácil (Odd Baixa)
    let bttsYes = 1.95; // Base
    
    // Ajuste fino baseado nas odds principais
    if (E < 3.0) bttsYes = 1.85; // Jogo truncado
    if (C < 1.5 || F < 1.5) bttsYes = 2.05; // Jogo de um time só (Goleada provável de um lado só)
    
    // Cálculo do inverso (Não)
    const probYes = 1 / bttsYes;
    const probNo = 1 - probYes;
    const bttsNo = (1 / probNo) * 1.05; // Spread pequeno

    return [
        {
            grupo: "Total de Gols",
            itens: [
                { nome: "Mais 1.5", odd: fx(1.25 + (E/10)) }, { nome: "Menos 1.5", odd: fx(3.50) },
                { nome: "Mais 2.5", odd: fx(1.90 + (E/20)) }, { nome: "Menos 2.5", odd: fx(1.80) }
            ]
        },
        {
            grupo: "Ambas Marcam",
            itens: [ 
                { nome: "Sim", odd: fx(bttsYes) }, 
                { nome: "Não", odd: fx(bttsNo) } 
            ]
        },
        {
            grupo: "Chance Dupla",
            itens: [ 
                { nome: "Casa/Empate", odd: fx(dc1X) }, 
                { nome: "Casa/Fora", odd: fx(dc12) }, 
                { nome: "Empate/Fora", odd: fx(dcX2) } 
            ]
        },
        {
            grupo: "Placar Exato",
            itens: [
                { nome: "1-0", odd: fx(C * 3.1) }, 
                { nome: "2-0", odd: fx(C * 4.9) }, 
                { nome: "0-1", odd: fx(F * 3.1) }, 
                { nome: "0-2", odd: fx(F * 4.9) },
                { nome: "1-1", odd: fx(E * 1.9) }
            ]
        }
    ];
}

app.post('/api/finalizar', async (req, res) => {
    try {
        let { usuario_id, valor, apostas } = req.body;
        if(!apostas || !apostas.length) return res.status(400).json({erro: "Vazio"});
        let oddTotal = 1.0; apostas.forEach(a => oddTotal *= parseFloat(a.odd));
        let retorno = parseFloat(valor) * oddTotal;
        if(retorno > CONFIG.MAX_PREMIO) retorno = CONFIG.MAX_PREMIO;
        const codigo = "GB" + Math.floor(100000 + Math.random() * 900000);
        await pool.query('INSERT INTO bilhetes (usuario_id, codigo, valor, retorno, odds_total, detalhes) VALUES ($1, $2, $3, $4, $5, $6)', [usuario_id||1, codigo, valor, retorno.toFixed(2), oddTotal.toFixed(2), JSON.stringify(apostas)]);
        res.json({sucesso: true, codigo, retorno: retorno.toFixed(2)});
    } catch (e) { res.status(500).json({erro: "Erro"}); }
});
app.get('/api/admin/resumo', async (req, res) => { try { const f = await pool.query(`SELECT COUNT(*) as t, SUM(valor) as e, SUM(retorno) as r FROM bilhetes`); const u = await pool.query(`SELECT codigo, valor, retorno, data FROM bilhetes ORDER BY data DESC LIMIT 10`); res.json({ caixa: { total: f.rows[0].t, entrada: `R$ ${parseFloat(f.rows[0].e||0).toFixed(2)}`, risco: `R$ ${parseFloat(f.rows[0].r||0).toFixed(2)}` }, ultimos: u.rows }); } catch (e) { res.status(500).json({ erro: "Erro" }); } });
app.post('/api/login', async (req, res) => { res.json({sucesso:false}); });
app.listen(process.env.PORT || 3000, () => console.log("🔥 Server V56 On!"));
