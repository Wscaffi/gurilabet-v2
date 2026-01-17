const express = require('express');
const axios = require('axios');
const { Pool } = require('pg');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors({ origin: '*' }));

const CONFIG = {
    API_KEY: process.env.API_FOOTBALL_KEY || "SUA_CHAVE_AQUI", 
    LUCRO_CASA: 0.85, 
    TEMPO_CACHE_MINUTOS: 5, // Cache curto pra atualizar logo
    MIN_VALOR: 2.00,
    MAX_VALOR: 1000.00,
    MAX_PREMIO: 10000.00,
    
    // LISTA VIP (Mantida igual)
    LIGAS_VIP: [
        "Premier League", "La Liga", "Serie A", "Bundesliga", "Ligue 1", 
        "Brasileirão", "Paulista", "Carioca", "Mineiro", "Gaucho", "Baiano", "Pernambucano", "Cearense",
        "Champions League", "Libertadores", "Sudamericana", "Copa do Nordeste"
    ]
};

const TIMES_FORTES = ["Flamengo", "Palmeiras", "Atlético-MG", "Real Madrid", "Barcelona", "Man City", "Liverpool", "PSG", "Bayern", "Inter", "Arsenal", "Botafogo", "São Paulo", "Corinthians", "Grêmio", "Boca Juniors", "River Plate", "Juventus", "Milan", "Vasco", "Fluminense"];

const TRADUCOES = { 
    "World": "Mundo", "Brazil": "Brasil", "England": "Inglaterra", "Spain": "Espanha", "Italy": "Itália", "Germany": "Alemanha", "France": "França", "Portugal": "Portugal", 
    "Premier League": "Premier League", "Serie A": "Série A", "La Liga": "La Liga", "Bundesliga": "Bundesliga", "Ligue 1": "Ligue 1", 
    "Brasileiro Série A": "Brasileirão A", "Brasileiro Série B": "Brasileirão B",
    "Carioca - 1": "Carioca", "Carioca - A2": "Carioca A2", "Taca Guanabara": "Carioca", "Campeonato Carioca": "Carioca", "Carioca Serie A": "Carioca",
    "Paulista - A1": "Paulista A1", "Copa Libertadores": "Libertadores", "UEFA Champions League": "Champions League"
};

function traduzir(txt) { return TRADUCOES[txt] || txt; }

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function initDb() {
    try {
        await pool.query(`CREATE TABLE IF NOT EXISTS bilhetes (id SERIAL PRIMARY KEY, usuario_id INTEGER, codigo TEXT UNIQUE, valor NUMERIC, retorno NUMERIC, odds_total NUMERIC, status TEXT DEFAULT 'pendente', detalhes JSONB, data TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
        await pool.query(`CREATE TABLE IF NOT EXISTS jogos_cache (id SERIAL PRIMARY KEY, data_ref TEXT UNIQUE, json_dados JSONB, atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
        console.log("✅ Servidor V48 (Fuso Horário BR) Online!");
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
        
        // --- AQUI ESTÁ A CORREÇÃO: timezone=America/Sao_Paulo ---
        // Só isso mudou. O resto continua igual.
        const url = `https://v3.football.api-sports.io/fixtures?date=${dataHoje}&timezone=America/Sao_Paulo`; 
        
        const resp = await axios.get(url, { headers: { 'x-apisports-key': CONFIG.API_KEY } });
        
        let jogos = [];
        if (resp.data.response) jogos = formatarV48(resp.data.response);
        
        if (jogos.length > 0) {
            await pool.query(`INSERT INTO jogos_cache (data_ref, json_dados, atualizado_em) VALUES ($1, $2, NOW()) ON CONFLICT (data_ref) DO UPDATE SET json_dados = $2, atualizado_em = NOW()`, [dataHoje, JSON.stringify(jogos)]);
        }
        res.json(jogos);
    } catch (e) { res.json([]); }
});

app.post('/api/finalizar', async (req, res) => {
    try {
        let { usuario_id, valor, apostas } = req.body;
        if(!apostas || !apostas.length) return res.status(400).json({erro: "Vazio"});
        valor = parseFloat(valor);
        if(valor < CONFIG.MIN_VALOR) return res.status(400).json({erro: `Mínimo R$ ${CONFIG.MIN_VALOR}`});
        
        let oddTotal = 1.0;
        apostas.forEach(a => oddTotal *= parseFloat(a.odd));
        let retorno = valor * oddTotal;
        if(retorno > CONFIG.MAX_PREMIO) retorno = CONFIG.MAX_PREMIO;

        const codigo = "GB" + Math.floor(100000 + Math.random() * 900000);
        await pool.query('INSERT INTO bilhetes (usuario_id, codigo, valor, retorno, odds_total, detalhes) VALUES ($1, $2, $3, $4, $5, $6)', [usuario_id||1, codigo, valor, retorno.toFixed(2), oddTotal.toFixed(2), JSON.stringify(apostas)]);
        res.json({sucesso: true, codigo, retorno: retorno.toFixed(2)});
    } catch (e) { res.status(500).json({erro: "Erro"}); }
});

function formatarV48(lista) {
    return lista.map(j => {
        try {
            // Filtro leve: Só tira o que já acabou (FT) ou foi adiado.
            // Mantém NS (Não Iniciado) e TBD (A definir).
            const st = j.fixture.status.short;
            if (['FT', 'AET', 'PEN', 'SUSP', 'INT', 'PST'].includes(st)) return null;

            const ligaOrig = j.league.name;
            const paisOrig = j.league.country;
            const ligaNome = (paisOrig === "World" ? traduzir(ligaOrig) : `${traduzir(paisOrig)} - ${traduzir(ligaOrig)}`).toUpperCase();
            
            const ehVIP = CONFIG.LIGAS_VIP.some(v => ligaNome.includes(v.toUpperCase()));
            const oddsBase = calcularOddsSeguras(j.teams.home.name, j.teams.away.name);

            return {
                id: j.fixture.id,
                liga: ligaNome,
                flag: j.league.flag || "https://cdn-icons-png.flaticon.com/512/53/53280.png",
                home: { name: j.teams.home.name, logo: j.teams.home.logo },
                away: { name: j.teams.away.name, logo: j.teams.away.logo },
                data: j.fixture.date,
                status: "VS",
                odds: oddsBase,
                // Mantém seus mercados como estavam
                mercados: ehVIP ? gerarListaMercadosExpandida(oddsBase) : [] 
            };
        } catch (e) { return null; }
    }).filter(Boolean);
}

function calcularOddsSeguras(home, away) {
    const hStrong = TIMES_FORTES.some(t => home.includes(t));
    const aStrong = TIMES_FORTES.some(t => away.includes(t));
    let c = 2.45, e = 3.15, f = 2.85; 
    if (hStrong && !aStrong) { c = 1.42; e = 4.30; f = 7.20; } 
    else if (aStrong && !hStrong) { c = 5.80; e = 3.90; f = 1.52; }
    c += Math.random()*0.2; f += Math.random()*0.2;
    return { casa: (c*CONFIG.LUCRO_CASA).toFixed(2), empate: (e*CONFIG.LUCRO_CASA).toFixed(2), fora: (f*CONFIG.LUCRO_CASA).toFixed(2) };
}

// --- LISTA DE MERCADOS (A QUE VOCÊ APROVOU) ---
function gerarListaMercadosExpandida(base) {
    const C = parseFloat(base.casa); const E = parseFloat(base.empate); const F = parseFloat(base.fora);
    const k = 0.90; 
    const fx = (v) => (v * k).toFixed(2);

    return [
        {
            grupo: "Total de Gols",
            itens: [
                { nome: "Mais 0.5", odd: fx(1.05) }, { nome: "Menos 0.5", odd: fx(8.50) },
                { nome: "Mais 1.5", odd: fx(1.28) }, { nome: "Menos 1.5", odd: fx(3.30) },
                { nome: "Mais 2.5", odd: fx(1.90) }, { nome: "Menos 2.5", odd: fx(1.85) },
                { nome: "Mais 3.5", odd: fx(3.20) }, { nome: "Menos 3.5", odd: fx(1.25) },
                { nome: "Mais 4.5", odd: fx(5.80) }, { nome: "Menos 4.5", odd: fx(1.10) },
                { nome: "Mais 5.5", odd: fx(9.50) }, { nome: "Menos 5.5", odd: fx(1.03) }
            ]
        },
        {
            grupo: "Ambas Marcam",
            itens: [ { nome: "Sim", odd: fx(1.85) }, { nome: "Não", odd: fx(1.85) } ]
        },
        {
            grupo: "Chance Dupla",
            itens: [ { nome: "Casa/Empate", odd: fx(1.15) }, { nome: "Casa/Fora", odd: fx(1.25) }, { nome: "Empate/Fora", odd: fx(1.15) } ]
        },
        {
            grupo: "Empate não tem aposta",
            itens: [ { nome: "Casa", odd: fx(C*0.7) }, { nome: "Fora", odd: fx(F*0.7) } ]
        },
        {
            grupo: "Vencedor 1º Tempo",
            itens: [ { nome: "Casa", odd: fx(C+1) }, { nome: "Empate", odd: fx(2.10) }, { nome: "Fora", odd: fx(F+1) } ]
        },
        {
            grupo: "Escanteios",
            itens: [ 
                { nome: "Mais 8.5", odd: fx(1.60) }, { nome: "Menos 8.5", odd: fx(2.10) },
                { nome: "Mais 9.5", odd: fx(1.85) }, { nome: "Menos 9.5", odd: fx(1.80) },
                { nome: "Mais 10.5", odd: fx(2.30) }, { nome: "Menos 10.5", odd: fx(1.50) },
                { nome: "Casa Mais Cantos", odd: fx(1.60) }, { nome: "Fora Mais Cantos", odd: fx(2.20) } 
            ]
        },
        {
            grupo: "Placar Exato",
            itens: [
                { nome: "1-0", odd: fx(C*3) }, { nome: "2-0", odd: fx(C*4) }, { nome: "2-1", odd: fx(C*5) },
                { nome: "0-1", odd: fx(F*3) }, { nome: "0-2", odd: fx(F*4) }, { nome: "1-2", odd: fx(F*5) },
                { nome: "0-0", odd: "8.50" }, { nome: "1-1", odd: "6.00" }, { nome: "2-2", odd: "12.00" },
                { nome: "3-0", odd: fx(C*8) }, { nome: "0-3", odd: fx(F*8) }
            ]
        },
        {
            grupo: "Handicap Europeu",
            itens: [
                { nome: "Casa -1", odd: fx(C*2.5) }, { nome: "Fora +1", odd: fx(1.30) },
                { nome: "Casa +1", odd: fx(1.15) }, { nome: "Fora -1", odd: fx(F*2.5) }
            ]
        }
    ];
}

app.post('/api/login', async (req, res) => { res.json({sucesso:false}); });
app.listen(process.env.PORT || 3000, () => console.log("🔥 Server V48 On!"));
