const express = require('express');
const axios = require('axios');
const { Pool } = require('pg');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors({ origin: '*' }));

const CONFIG = {
    API_KEY: process.env.API_FOOTBALL_KEY || "SUA_CHAVE_AQUI", 
    LUCRO_CASA: 0.90, 
    // Cache de 15 min para não estourar API, mas curto o suficiente pra atualizar
    TEMPO_CACHE_MINUTOS: 15, 
    MIN_VALOR: 2.00,
    MAX_VALOR: 1000.00,
    MAX_PREMIO: 10000.00,
    LIGAS_VIP: ["Premier League", "La Liga", "Serie A", "Brasileirão", "Paulista", "Carioca", "Champions League", "Libertadores"]
};

// Times para simulação (backup)
const TIMES_FORTES = ["Palmeiras", "Real Madrid", "Barcelona", "Man City", "Liverpool", "PSG", "Bayern", "Milan", "Inter", "Arsenal"];
const TRADUCOES = { "World": "Mundo", "Brazil": "Brasil", "England": "Inglaterra", "Spain": "Espanha", "Italy": "Itália", "Germany": "Alemanha", "France": "França", "Portugal": "Portugal", "Premier League": "Premier League", "Serie A": "Série A", "La Liga": "La Liga", "Carioca - 1": "Carioca", "Paulista - A1": "Paulista A1", "Copa Libertadores": "Libertadores", "UEFA Champions League": "Champions League" };
function traduzir(txt) { return TRADUCOES[txt] || txt; }

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function initDb() {
    try {
        await pool.query(`CREATE TABLE IF NOT EXISTS bilhetes (id SERIAL PRIMARY KEY, usuario_id INTEGER, codigo TEXT UNIQUE, valor NUMERIC, retorno NUMERIC, odds_total NUMERIC, status TEXT DEFAULT 'pendente', detalhes JSONB, data TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
        await pool.query(`CREATE TABLE IF NOT EXISTS jogos_cache (id SERIAL PRIMARY KEY, data_ref TEXT UNIQUE, json_dados JSONB, atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
        await pool.query("DELETE FROM jogos_cache"); // Limpa ao reiniciar
        console.log("✅ Servidor V59 (Filtro de Horário Brutal) On!");
    } catch (e) { console.error(e); }
}
initDb();

app.get('/api/jogos', async (req, res) => {
    const dataHoje = req.query.data || new Date().toISOString().split('T')[0];
    try {
        const cache = await pool.query("SELECT json_dados, atualizado_em FROM jogos_cache WHERE data_ref = $1", [dataHoje]);
        if (cache.rows.length > 0) {
            const diff = (new Date() - new Date(cache.rows[0].atualizado_em)) / 1000 / 60;
            if (diff < CONFIG.TEMPO_CACHE_MINUTOS) return res.json(cache.rows[0].json_dados);
        }
        
        console.log("🌍 Buscando API...");
        const headers = { 'x-apisports-key': CONFIG.API_KEY };
        const url = `https://v3.football.api-sports.io/fixtures?date=${dataHoje}&timezone=America/Sao_Paulo`; 
        const resp = await axios.get(url, { headers });
        
        // Mapa de Odds (Tentativa)
        let mapaOdds = {};
        try {
            const respOdds = await axios.get(`https://v3.football.api-sports.io/odds?date=${dataHoje}&bookmaker=6&timezone=America/Sao_Paulo`, { headers });
            if(respOdds.data.response) respOdds.data.response.forEach(o => { mapaOdds[o.fixture.id] = o.bookmakers[0].bets; });
        } catch (e) {}

        let jogosFinais = [];
        if (resp.data.response) jogosFinais = formatarV59(resp.data.response, mapaOdds);
        
        if (jogosFinais.length > 0) {
            await pool.query(`INSERT INTO jogos_cache (data_ref, json_dados, atualizado_em) VALUES ($1, $2, NOW()) ON CONFLICT (data_ref) DO UPDATE SET json_dados = $2, atualizado_em = NOW()`, [dataHoje, JSON.stringify(jogosFinais)]);
        }
        res.json(jogosFinais);
    } catch (e) { res.json([]); }
});

function formatarV59(listaJogos, mapaOdds) {
    const agora = Date.now();
    return listaJogos.map(j => {
        try {
            const st = j.fixture.status.short;
            const horaJogo = new Date(j.fixture.date).getTime();
            
            // --- FILTRO BRUTAL ---
            // 1. Se status for finalizado ou rolando -> TCHAU
            if (['FT', 'AET', 'PEN', '1H', '2H', 'HT', 'ET', 'P', 'BT', 'INT'].includes(st)) return null;

            // 2. Se o jogo começou há mais de 120 minutos (2 horas) e ainda tá na lista -> TCHAU (Erro da API)
            // Isso mata os jogos das 18h que ficam presos
            if (agora > (horaJogo + 120 * 60 * 1000)) return null;

            const oddsReais = mapaOdds[j.fixture.id]; 
            let oddsBase;

            if (oddsReais) {
                const winner = oddsReais.find(b => b.id === 1);
                if (winner) {
                    oddsBase = {
                        casa: parseFloat(winner.values.find(v=>v.value==='Home').odd),
                        empate: parseFloat(winner.values.find(v=>v.value==='Draw').odd),
                        fora: parseFloat(winner.values.find(v=>v.value==='Away').odd)
                    };
                } else { oddsBase = gerarOddUnica(j.teams.home.name, j.teams.away.name); }
            } else { oddsBase = gerarOddUnica(j.teams.home.name, j.teams.away.name); }

            const oddsFinais = {
                casa: (oddsBase.casa * CONFIG.LUCRO_CASA).toFixed(2),
                empate: (oddsBase.empate * CONFIG.LUCRO_CASA).toFixed(2),
                fora: (oddsBase.fora * CONFIG.LUCRO_CASA).toFixed(2)
            };
            
            const mercadosCalculados = gerarMercadosCompletos(oddsBase);
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

function gerarOddUnica(home, away) {
    let seed = 0; const combo = home + away;
    for(let i=0; i<combo.length; i++) seed += combo.charCodeAt(i);
    const varCasa = (seed % 30) / 100;
    const varFora = (seed % 20) / 100;
    return { casa: 2.30 + varCasa, empate: 3.10 + varFora, fora: 2.70 + (0.30 - varCasa) };
}

function gerarMercadosCompletos(base) {
    const C = parseFloat(base.casa); const E = parseFloat(base.empate); const F = parseFloat(base.fora);
    const k = 0.90; const fx = (v) => (v * k).toFixed(2);
    const probC = 1/C; const probE = 1/E; const probF = 1/F;
    const dc1X = 1 / (probC + probE); const dc12 = 1 / (probC + probF); const dcX2 = 1 / (probE + probF);
    let bttsYes = 1.95; if(E < 3.2) bttsYes = 1.75; if(C < 1.4 || F < 1.4) bttsYes = 2.10;
    const bttsNo = (1 / (1 - (1/bttsYes))) * 1.05;

    return [
        {
            grupo: "Total de Gols",
            itens: [
                { nome: "Mais 0.5", odd: fx(1.06) }, { nome: "Menos 0.5", odd: fx(10.0) },
                { nome: "Mais 1.5", odd: fx(1.29) }, { nome: "Menos 1.5", odd: fx(3.40) },
                { nome: "Mais 2.5", odd: fx(1.95) }, { nome: "Menos 2.5", odd: fx(1.85) },
                { nome: "Mais 3.5", odd: fx(3.30) }, { nome: "Menos 3.5", odd: fx(1.30) },
                { nome: "Mais 4.5", odd: fx(6.50) }, { nome: "Menos 4.5", odd: fx(1.10) },
                { nome: "Mais 5.5", odd: fx(13.0) }, { nome: "Menos 5.5", odd: fx(1.02) }
            ]
        },
        {
            grupo: "Ambas Marcam",
            itens: [ { nome: "Sim", odd: fx(bttsYes) }, { nome: "Não", odd: fx(bttsNo) } ]
        },
        {
            grupo: "Chance Dupla",
            itens: [ { nome: "Casa/Empate", odd: fx(dc1X) }, { nome: "Casa/Fora", odd: fx(dc12) }, { nome: "Empate/Fora", odd: fx(dcX2) } ]
        },
        {
            grupo: "Empate não tem aposta",
            itens: [ { nome: "Casa", odd: fx(C*0.75) }, { nome: "Fora", odd: fx(F*0.75) } ]
        },
        {
            grupo: "Vencedor 1º Tempo",
            itens: [ { nome: "Casa", odd: fx(C+1.1) }, { nome: "Empate", odd: fx(2.05) }, { nome: "Fora", odd: fx(F+1.1) } ]
        },
        {
            grupo: "Escanteios",
            itens: [ 
                { nome: "Mais 8.5", odd: fx(1.60) }, { nome: "Menos 8.5", odd: fx(2.10) },
                { nome: "Mais 9.5", odd: fx(1.85) }, { nome: "Menos 9.5", odd: fx(1.80) },
                { nome: "Mais 10.5", odd: fx(2.30) }, { nome: "Menos 10.5", odd: fx(1.50) },
                { nome: "Casa Mais", odd: fx(1.60) }, { nome: "Fora Mais", odd: fx(2.20) } 
            ]
        },
        {
            grupo: "Placar Exato",
            itens: [
                { nome: "1-0", odd: fx(C*3.1) }, { nome: "2-0", odd: fx(C*4.9) }, { nome: "2-1", odd: fx(C*5.5) },
                { nome: "0-1", odd: fx(F*3.1) }, { nome: "0-2", odd: fx(F*4.9) }, { nome: "1-2", odd: fx(F*5.5) },
                { nome: "0-0", odd: fx(8.50) }, { nome: "1-1", odd: fx(6.00) }, { nome: "2-2", odd: fx(14.0) }
            ]
        },
        {
            grupo: "Handicap Europeu",
            itens: [
                { nome: "Casa -1", odd: fx(C*2.4) }, { nome: "Fora +1", odd: fx(1.25) },
                { nome: "Casa +1", odd: fx(1.12) }, { nome: "Fora -1", odd: fx(F*2.4) }
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
app.listen(process.env.PORT || 3000, () => console.log("🔥 Server V59 (Filtro Tempo) On!"));
