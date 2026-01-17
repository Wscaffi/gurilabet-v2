const express = require('express');
const axios = require('axios');
const { Pool } = require('pg');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors({ origin: '*' }));

// --- ⚙️ GESTÃO DE RISCO (CONFIGURAÇÃO) ---
const CONFIG = {
    // ⬇️ SUA CHAVE API AQUI
    API_KEY: process.env.API_FOOTBALL_KEY || "SUA_CHAVE_AQUI", 
    
    LUCRO_CASA: 0.88,       // Margem da Banca (Quanto menor, menos paga)
    TEMPO_CACHE_MINUTOS: 30,// Economia de API
    
    // 🔒 TRAVAS DE SEGURANÇA (IMPORTANTE)
    MIN_VALOR_APOSTA: 2.00,     // Mínimo para apostar
    MAX_VALOR_APOSTA: 500.00,   // Máximo que aceita por bilhete
    MAX_PREMIO_PAGO: 5000.00,   // TETO DE PAGAMENTO (Se der mais, corta pra esse valor)
    MAX_JOGOS_BILHETE: 15,      // Máximo de jogos no cupom
    MAX_ODD_POR_JOGO: 30.00     // Se alguém tentar fraudar odd > 30 num jogo só, bloqueia
};

const TIMES_FORTES = ["Flamengo", "Palmeiras", "Atlético-MG", "Real Madrid", "Barcelona", "Man City", "Liverpool", "PSG", "Bayern", "Inter", "Arsenal", "Botafogo", "São Paulo", "Corinthians", "Grêmio", "Boca Juniors", "River Plate", "Juventus", "Milan"];

const TRADUCOES = {
    "World": "Mundo", "Brazil": "Brasil", "England": "Inglaterra", "Spain": "Espanha",
    "Italy": "Itália", "Germany": "Alemanha", "France": "França", "Portugal": "Portugal",
    "Netherlands": "Holanda", "Belgium": "Bélgica", "Argentina": "Argentina",
    "Premier League": "Premier League", "Serie A": "Série A", "La Liga": "La Liga",
    "Bundesliga": "Bundesliga", "Ligue 1": "Ligue 1", "Primeira Liga": "Primeira Liga",
    "Brasileiro Série A": "Brasileirão Série A", "Brasileiro Série B": "Brasileirão Série B",
    "Paulista - A1": "Paulista A1", "Carioca - 1": "Carioca", "Copa Libertadores": "Libertadores",
    "UEFA Champions League": "Champions League", "Friendly": "Amistoso"
};

function traduzir(texto) { return TRADUCOES[texto] || texto; }

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function initDb() {
    try {
        await pool.query(`CREATE TABLE IF NOT EXISTS bilhetes (id SERIAL PRIMARY KEY, usuario_id INTEGER, codigo TEXT UNIQUE, valor NUMERIC, retorno NUMERIC, odds_total NUMERIC, status TEXT DEFAULT 'pendente', detalhes JSONB, data TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
        await pool.query(`CREATE TABLE IF NOT EXISTS jogos_cache (id SERIAL PRIMARY KEY, data_ref TEXT UNIQUE, json_dados JSONB, atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
        console.log("✅ Servidor V35 (BLINDADO) Online!");
    } catch (e) { console.error("Erro DB:", e.message); }
}
initDb();

// --- ROTA DE JOGOS (SEM MUDANÇAS NA LÓGICA, SÓ SEGURANÇA NO FINALIZAR) ---
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

// --- 🔒 ROTA FINALIZAR COM SEGURANÇA HACKER ---
app.post('/api/finalizar', async (req, res) => {
    try {
        let { usuario_id, valor, apostas, odd_total } = req.body;
        
        // 1. VALIDAÇÃO DE ENTRADA
        if (!apostas || !Array.isArray(apostas) || apostas.length === 0) return res.status(400).json({ erro: "Cupom vazio." });
        if (apostas.length > CONFIG.MAX_JOGOS_BILHETE) return res.status(400).json({ erro: `Máximo de ${CONFIG.MAX_JOGOS_BILHETE} jogos por bilhete.` });

        // 2. VALIDAÇÃO DE VALORES
        valor = parseFloat(valor);
        if (isNaN(valor) || valor < CONFIG.MIN_VALOR_APOSTA) return res.status(400).json({ erro: `Aposta mínima: R$ ${CONFIG.MIN_VALOR_APOSTA.toFixed(2)}` });
        if (valor > CONFIG.MAX_VALOR_APOSTA) return res.status(400).json({ erro: `Aposta máxima: R$ ${CONFIG.MAX_VALOR_APOSTA.toFixed(2)}` });

        // 3. SEGURANÇA ANTI-FRAUDE DE ODDS
        // Se alguém editou o HTML para colocar odd 1000, a gente pega aqui
        let oddCalculadaSegura = 1.0;
        let fraudeDetectada = false;

        apostas.forEach(aposta => {
            let oddItem = parseFloat(aposta.odd);
            if (oddItem > CONFIG.MAX_ODD_POR_JOGO) fraudeDetectada = true; // Odd individual suspeita
            if (oddItem <= 1.0) oddItem = 1.0; // Evita bugs matemáticos
            oddCalculadaSegura *= oddItem;
        });

        if (fraudeDetectada) return res.status(400).json({ erro: "Erro nas cotações (Odd inválida detectada)." });

        // 4. LIMITADOR DE PRÊMIO (A CEREJA DO BOLO)
        // Se o prêmio passar do limite da banca, a gente trava no limite
        let retornoPotencial = valor * oddCalculadaSegura;
        
        if (retornoPotencial > CONFIG.MAX_PREMIO_PAGO) {
            retornoPotencial = CONFIG.MAX_PREMIO_PAGO; // CORTA O PRÊMIO
            // Opcional: Avisar no front que foi limitado, mas aqui a gente só salva o limitado.
        }

        const codigo = "GB" + Math.floor(100000 + Math.random() * 900000);
        
        await pool.query('INSERT INTO bilhetes (usuario_id, codigo, valor, retorno, odds_total, detalhes) VALUES ($1, $2, $3, $4, $5, $6)', 
            [usuario_id || 1, codigo, valor, retornoPotencial.toFixed(2), oddCalculadaSegura.toFixed(2), JSON.stringify(apostas)]);
            
        res.json({ sucesso: true, codigo, retorno: retornoPotencial.toFixed(2) });

    } catch (e) { 
        console.error("Erro aposta:", e);
        res.status(500).json({ erro: "Erro ao processar. Tente novamente." }); 
    }
});

// --- FUNÇÕES DE FORMATAÇÃO (MANTIDAS DA V34) ---
function formatarAPIOficial(lista) {
    return lista.map(j => {
        try {
            const paisOrig = j.league.country;
            const ligaOrig = j.league.name;
            const paisTrad = traduzir(paisOrig);
            const ligaTrad = traduzir(ligaOrig);
            const ligaNomeFinal = (paisOrig === "World" ? ligaTrad : `${paisTrad} - ${ligaTrad}`).toUpperCase();
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

function traduzirStatus(st) {
    if(st === 'NS') return 'VS'; if(['1H','2H','HT','ET','P'].includes(st)) return 'AO VIVO'; if(st === 'FT') return 'ENC'; return st;
}

function calcularOddsBase(home, away) {
    const hStrong = TIMES_FORTES.some(t => home.includes(t)); const aStrong = TIMES_FORTES.some(t => away.includes(t));
    let c = 2.40, e = 3.20, f = 2.80;
    if (hStrong && !aStrong) { c = 1.45; e = 4.20; f = 6.50; } else if (aStrong && !hStrong) { c = 5.50; e = 3.90; f = 1.55; }
    c += (Math.random() * 0.2); f += (Math.random() * 0.2);
    return { casa: aplicarMargem(c), empate: aplicarMargem(e), fora: aplicarMargem(f) };
}

function aplicarMargem(v) { return (parseFloat(v) * CONFIG.LUCRO_CASA).toFixed(2); }

function gerarMercadosExtras(base) { 
    const C = parseFloat(base.casa); const m = CONFIG.LUCRO_CASA; const calc = (v) => (v * m).toFixed(2); 
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

// ROTAS DE LOGIN
app.post('/api/login', async (req, res) => { res.json({sucesso:false}); }); 
app.listen(process.env.PORT || 3000, () => console.log("🔥 Server V35 (BLINDADO) On!"));
