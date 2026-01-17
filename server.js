const express = require('express');
const axios = require('axios');
const { Pool } = require('pg');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors({ origin: '*' }));

const CONFIG = {
    API_KEY: process.env.API_FOOTBALL_KEY || "SUA_CHAVE_AQUI", 
    LUCRO_CASA: 0.88,
    TEMPO_CACHE_MINUTOS: 30,
    MIN_VALOR_APOSTA: 2.00,
    MAX_VALOR_APOSTA: 500.00,
    MAX_PREMIO_PAGO: 5000.00,
    MAX_JOGOS_BILHETE: 20,
    MAX_ODD_POR_JOGO: 50.00
};

const TIMES_FORTES = ["Flamengo", "Palmeiras", "Atlético-MG", "Real Madrid", "Barcelona", "Man City", "Liverpool", "PSG", "Bayern", "Inter", "Arsenal", "Botafogo", "São Paulo", "Corinthians", "Grêmio", "Boca Juniors", "River Plate", "Juventus", "Milan"];
const TRADUCOES = { "World": "Mundo", "Brazil": "Brasil", "England": "Inglaterra", "Spain": "Espanha", "Italy": "Itália", "Germany": "Alemanha", "France": "França", "Portugal": "Portugal", "Netherlands": "Holanda", "Belgium": "Bélgica", "Argentina": "Argentina", "Premier League": "Premier League", "Serie A": "Série A", "La Liga": "La Liga", "Bundesliga": "Bundesliga", "Ligue 1": "Ligue 1", "Primeira Liga": "Primeira Liga", "Brasileiro Série A": "Brasileirão Série A", "Brasileiro Série B": "Brasileirão Série B", "Copa Libertadores": "Libertadores", "UEFA Champions League": "Champions League", "Friendly": "Amistoso" };

function traduzir(texto) { return TRADUCOES[texto] || texto; }

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function initDb() {
    try {
        await pool.query(`CREATE TABLE IF NOT EXISTS bilhetes (id SERIAL PRIMARY KEY, usuario_id INTEGER, codigo TEXT UNIQUE, valor NUMERIC, retorno NUMERIC, odds_total NUMERIC, status TEXT DEFAULT 'pendente', detalhes JSONB, data TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
        await pool.query(`CREATE TABLE IF NOT EXISTS jogos_cache (id SERIAL PRIMARY KEY, data_ref TEXT UNIQUE, json_dados JSONB, atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
        console.log("✅ Servidor V38 (FULL MARKETS) Online!");
    } catch (e) { console.error("Erro DB:", e.message); }
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
        const url = `https://v3.football.api-sports.io/fixtures?date=${dataHoje}&status=NS-1H-2H-HT-FT`;
        const resp = await axios.get(url, { headers: { 'x-apisports-key': CONFIG.API_KEY } });
        let jogos = [];
        if (resp.data.response) jogos = formatarAPIOficial(resp.data.response);
        if (jogos.length > 0) {
            await pool.query(`INSERT INTO jogos_cache (data_ref, json_dados, atualizado_em) VALUES ($1, $2, NOW()) ON CONFLICT (data_ref) DO UPDATE SET json_dados = $2, atualizado_em = NOW()`, [dataHoje, JSON.stringify(jogos)]);
        }
        res.json(jogos);
    } catch (e) { console.error("Erro:", e.message); res.json([]); }
});

app.post('/api/finalizar', async (req, res) => {
    try {
        let { usuario_id, valor, apostas } = req.body;
        if (!apostas || apostas.length === 0) return res.status(400).json({ erro: "Cupom vazio." });
        if (apostas.length > CONFIG.MAX_JOGOS_BILHETE) return res.status(400).json({ erro: `Máximo de ${CONFIG.MAX_JOGOS_BILHETE} jogos.` });
        
        valor = parseFloat(valor);
        if (valor < CONFIG.MIN_VALOR_APOSTA) return res.status(400).json({ erro: `Mínimo: R$ ${CONFIG.MIN_VALOR_APOSTA}` });
        if (valor > CONFIG.MAX_VALOR_APOSTA) return res.status(400).json({ erro: `Máximo: R$ ${CONFIG.MAX_VALOR_APOSTA}` });

        let oddTotal = 1.0;
        apostas.forEach(a => {
            let odd = parseFloat(a.odd);
            if(odd > CONFIG.MAX_ODD_POR_JOGO) odd = 1.0; 
            oddTotal *= odd;
        });

        let retorno = valor * oddTotal;
        if (retorno > CONFIG.MAX_PREMIO_PAGO) retorno = CONFIG.MAX_PREMIO_PAGO;

        const codigo = "GB" + Math.floor(100000 + Math.random() * 900000);
        await pool.query('INSERT INTO bilhetes (usuario_id, codigo, valor, retorno, odds_total, detalhes) VALUES ($1, $2, $3, $4, $5, $6)', [usuario_id || 1, codigo, valor, retorno.toFixed(2), oddTotal.toFixed(2), JSON.stringify(apostas)]);
        res.json({ sucesso: true, codigo, retorno: retorno.toFixed(2) });
    } catch (e) { res.status(500).json({ erro: "Erro ao processar." }); }
});

function formatarAPIOficial(lista) {
    return lista.map(j => {
        try {
            const paisOrig = j.league.country;
            const ligaOrig = j.league.name;
            const ligaNomeFinal = (paisOrig === "World" ? traduzir(ligaOrig) : `${traduzir(paisOrig)} - ${traduzir(ligaOrig)}`).toUpperCase();
            const flag = j.league.flag || "https://cdn-icons-png.flaticon.com/512/53/53280.png";
            const oddsBase = calcularOddsBase(j.teams.home.name, j.teams.away.name);
            return {
                id: j.fixture.id,
                liga: ligaNomeFinal,
                flag: flag,
                home: { name: j.teams.home.name, logo: j.teams.home.logo },
                away: { name: j.teams.away.name, logo: j.teams.away.logo },
                data: j.fixture.date,
                status: traduzirStatus(j.fixture.status.short),
                odds: oddsBase,
                mercados: gerarMercadosExtras(oddsBase)
            };
        } catch (e) { return null; }
    }).filter(Boolean);
}

function traduzirStatus(st) { if(st === 'NS') return 'VS'; if(['1H','2H','HT'].includes(st)) return 'AO VIVO'; if(st === 'FT') return 'ENC'; return st; }

function calcularOddsBase(home, away) {
    const hStrong = TIMES_FORTES.some(t => home.includes(t)); const aStrong = TIMES_FORTES.some(t => away.includes(t));
    let c = 2.40, e = 3.20, f = 2.80;
    if (hStrong && !aStrong) { c = 1.50; e = 4.00; f = 6.00; } else if (aStrong && !hStrong) { c = 5.50; e = 3.80; f = 1.55; }
    c += (Math.random() * 0.2); f += (Math.random() * 0.2);
    return { casa: aplicarMargem(c), empate: aplicarMargem(e), fora: aplicarMargem(f) };
}
function aplicarMargem(v) { return (parseFloat(v) * CONFIG.LUCRO_CASA).toFixed(2); }

function gerarMercadosExtras(base) {
    const C = parseFloat(base.casa); const E = parseFloat(base.empate); const F = parseFloat(base.fora);
    const m = CONFIG.LUCRO_CASA;
    const calc = (v) => (v * m).toFixed(2);
    
    return {
        // --- PRINCIPAIS ---
        dupla_chance: { "1X": calc(1.0 + (1/C)), "12": calc(1.30), "X2": calc(1.0 + (1/F)) },
        empate_anula: { "1": calc(C * 0.7), "2": calc(F * 0.7) },
        ambas_marcam: { "Sim": calc(1.90), "Não": calc(1.80) },
        par_impar: { "Ímpar": "1.90", "Par": "1.90" },
        
        // --- GOLS ---
        total_gols: { "Mais 1.5": calc(1.30), "Menos 1.5": calc(3.20), "Mais 2.5": calc(1.95), "Menos 2.5": calc(1.85), "Mais 3.5": calc(3.50), "Menos 3.5": calc(1.25) },
        
        // --- TEMPOS ---
        ht_vencedor: { "1": calc(C + 1.2), "X": calc(2.10), "2": calc(F + 1.2) },
        ft_vencedor_2tempo: { "1": calc(C + 0.6), "X": calc(2.40), "2": calc(F + 0.6) },
        primeiro_gol: { "Casa": calc(C * 0.9), "Fora": calc(F * 0.9), "Nenhum": calc(10.0) },

        // --- PLACAR EXATO (LISTA DO VÍDEO) ---
        placar_exato: {
            "1-0": calc(C * 3.5), "2-0": calc(C * 4.5), "2-1": calc(C * 5.5), "3-0": calc(C * 8.0), "3-1": calc(C * 9.0),
            "0-1": calc(F * 3.5), "0-2": calc(F * 4.5), "1-2": calc(F * 5.5), "0-3": calc(F * 8.0), "1-3": calc(F * 9.0),
            "0-0": calc(8.00), "1-1": calc(6.00), "2-2": calc(12.00)
        },

        // --- ESCANTEIOS (SIMULADO BASEADO NA FORÇA DO TIME) ---
        escanteios: {
            "Mais 8.5": calc(1.80), "Menos 8.5": calc(1.90),
            "Mais 9.5": calc(2.10), "Menos 9.5": calc(1.65),
            "Mais 10.5": calc(2.50), "Menos 10.5": calc(1.45),
            "Casa Mais Escanteios": calc(C * 0.8), 
            "Fora Mais Escanteios": calc(F * 0.8)
        },
        
        handicap: { "Casa -1": calc(C * 2.8), "Fora +1": calc(1.45) }
    };
}

// ROTAS LOGIN
app.post('/api/login', async (req, res) => { res.json({sucesso:false}); });
app.listen(process.env.PORT || 3000, () => console.log("🔥 Server V38 On!"));
