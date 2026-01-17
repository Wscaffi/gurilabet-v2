const express = require('express');
const axios = require('axios');
const { Pool } = require('pg');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors({ origin: '*' }));

// --- CONFIGURAÇÕES DE RISCO (AJUSTE FINO) ---
const CONFIG = {
    API_KEY: process.env.API_FOOTBALL_KEY || "SUA_CHAVE_AQUI", 
    LUCRO_CASA: 0.85, // Margem mais alta (0.85) para baixar as odds e proteger você
    TEMPO_CACHE_MINUTOS: 70,
    
    // LIMITES FINANCEIROS
    MIN_VALOR: 2.00,
    MAX_VALOR: 500.00,
    MAX_PREMIO: 3000.00, // Teto máximo de prêmio por bilhete
    MAX_ODD_ZEBRA: 8.50, // TRAVA: Nenhuma odd de time passa de 8.50 (Evita pagar 20x)
    
    // LISTA VIP (SÓ ESSAS LIGAS TERÃO MERCADOS EXTRAS - IGUAL SB99)
    LIGAS_VIP: [
        "Premier League", "La Liga", "Serie A", "Bundesliga", "Ligue 1", 
        "Brasileirão Série A", "Paulista A1", "Carioca", "Mineiro", 
        "UEFA Champions League", "Copa Libertadores", "Copa Sudamericana"
    ]
};

const TIMES_FORTES = ["Flamengo", "Palmeiras", "Atlético-MG", "Real Madrid", "Barcelona", "Man City", "Liverpool", "PSG", "Bayern", "Inter", "Arsenal", "Botafogo", "São Paulo", "Corinthians", "Grêmio", "Boca Juniors", "River Plate", "Juventus", "Milan"];

// TRADUTOR
const TRADUCOES = { "World": "Mundo", "Brazil": "Brasil", "England": "Inglaterra", "Spain": "Espanha", "Italy": "Itália", "Germany": "Alemanha", "France": "França", "Portugal": "Portugal", "Netherlands": "Holanda", "Belgium": "Bélgica", "Argentina": "Argentina", "Premier League": "Premier League", "Serie A": "Série A", "La Liga": "La Liga", "Bundesliga": "Bundesliga", "Ligue 1": "Ligue 1", "Brasileiro Série A": "Brasileirão Série A", "Brasileiro Série B": "Brasileirão Série B", "Paulista - A1": "Paulista A1", "Carioca - 1": "Carioca", "Copa Libertadores": "Libertadores", "UEFA Champions League": "Champions League", "Friendly": "Amistoso", "Copa São Paulo de Futebol Júnior": "Copinha" };

function traduzir(txt) { return TRADUCOES[txt] || txt; }

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function initDb() {
    try {
        await pool.query(`CREATE TABLE IF NOT EXISTS bilhetes (id SERIAL PRIMARY KEY, usuario_id INTEGER, codigo TEXT UNIQUE, valor NUMERIC, retorno NUMERIC, odds_total NUMERIC, status TEXT DEFAULT 'pendente', detalhes JSONB, data TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
        await pool.query(`CREATE TABLE IF NOT EXISTS jogos_cache (id SERIAL PRIMARY KEY, data_ref TEXT UNIQUE, json_dados JSONB, atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
        console.log("✅ Server V39 (Risk Manager) On!");
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
        const url = `https://v3.football.api-sports.io/fixtures?date=${dataHoje}&status=NS-1H-2H-HT-FT`;
        const resp = await axios.get(url, { headers: { 'x-apisports-key': CONFIG.API_KEY } });
        
        let jogos = [];
        if (resp.data.response) jogos = formatarComGestaoRisco(resp.data.response);
        
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
        if(valor > CONFIG.MAX_VALOR) return res.status(400).json({erro: `Máximo R$ ${CONFIG.MAX_VALOR}`});

        let oddTotal = 1.0;
        apostas.forEach(a => oddTotal *= parseFloat(a.odd));
        
        let retorno = valor * oddTotal;
        // TRAVA DE PAGAMENTO MÁXIMO
        if(retorno > CONFIG.MAX_PREMIO) retorno = CONFIG.MAX_PREMIO;

        const codigo = "GB" + Math.floor(100000 + Math.random() * 900000);
        await pool.query('INSERT INTO bilhetes (usuario_id, codigo, valor, retorno, odds_total, detalhes) VALUES ($1, $2, $3, $4, $5, $6)', 
            [usuario_id||1, codigo, valor, retorno.toFixed(2), oddTotal.toFixed(2), JSON.stringify(apostas)]);
        
        res.json({sucesso: true, codigo, retorno: retorno.toFixed(2)});
    } catch (e) { res.status(500).json({erro: "Erro interno"}); }
});

// --- INTELIGÊNCIA DE RISCO ---
function formatarComGestaoRisco(lista) {
    return lista.map(j => {
        try {
            const paisOrig = j.league.country;
            const ligaOrig = j.league.name;
            const ligaTrad = traduzir(ligaOrig);
            const paisTrad = traduzir(paisOrig);
            const ligaNomeFinal = (paisOrig === "World" ? ligaTrad : `${paisTrad} - ${ligaTrad}`).toUpperCase();
            
            // FILTRO DE ELITE: A liga é VIP?
            // Se for "Copinha", "Youth", "Amador", "2ª Divisão estranha" -> NÃO É VIP.
            const ehLigaVIP = CONFIG.LIGAS_VIP.some(vip => ligaNomeFinal.includes(vip.toUpperCase()));

            const oddsBase = calcularOddsSeguras(j.teams.home.name, j.teams.away.name);

            return {
                id: j.fixture.id,
                liga: ligaNomeFinal,
                flag: j.league.flag || "https://cdn-icons-png.flaticon.com/512/53/53280.png",
                home: { name: j.teams.home.name, logo: j.teams.home.logo },
                away: { name: j.teams.away.name, logo: j.teams.away.logo },
                data: j.fixture.date,
                status: statusCurto(j.fixture.status.short),
                odds: oddsBase,
                // SE NÃO FOR VIP, MANDA NULL (BLOQUEIA MERCADOS EXTRAS)
                mercados: ehLigaVIP ? gerarMercadosCompletos(oddsBase) : null 
            };
        } catch (e) { return null; }
    }).filter(Boolean);
}

function statusCurto(st) { if(st==='NS')return 'VS'; if(['1H','2H','HT'].includes(st))return 'VIVO'; return 'FIM'; }

// --- ODDS CALIBRADAS (BET365 STYLE) ---
function calcularOddsSeguras(home, away) {
    const hStrong = TIMES_FORTES.some(t => home.includes(t));
    const aStrong = TIMES_FORTES.some(t => away.includes(t));
    
    // Padrão: Jogo Equilibrado
    let c = 2.50, e = 3.10, f = 2.80; 

    if (hStrong && !aStrong) { 
        c = 1.40; e = 4.20; f = 7.50; // Favorito Casa (Zebra limitada a 7.50)
    } else if (aStrong && !hStrong) { 
        c = 6.80; e = 3.90; f = 1.45; // Favorito Fora (Zebra limitada a 6.80)
    }

    // Variação Aleatória Mínima (0.05 a 0.30)
    c += Math.random() * 0.3;
    f += Math.random() * 0.3;

    // TRAVA FINAL DE ZEBRA (Segurança Máxima)
    if(c > CONFIG.MAX_ODD_ZEBRA) c = CONFIG.MAX_ODD_ZEBRA;
    if(f > CONFIG.MAX_ODD_ZEBRA) f = CONFIG.MAX_ODD_ZEBRA;

    return { 
        casa: (c * CONFIG.LUCRO_CASA).toFixed(2), 
        empate: (e * CONFIG.LUCRO_CASA).toFixed(2), 
        fora: (f * CONFIG.LUCRO_CASA).toFixed(2) 
    };
}

// --- GERADOR DE MERCADOS COMPLETOS (SÓ PRA LIGAS VIP) ---
function gerarMercadosCompletos(base) {
    const C = parseFloat(base.casa); const E = parseFloat(base.empate); const F = parseFloat(base.fora);
    const calc = (v) => (v * 0.90).toFixed(2); // Margem extra nos especiais

    return {
        dupla_chance: { "1X": calc(1.15), "12": calc(1.25), "X2": calc(1.15) },
        empate_anula: { "1": calc(C*0.7), "2": calc(F*0.7) },
        ambas_marcam: { "Sim": "1.85", "Não": "1.85" },
        par_impar: { "Ímpar": "1.90", "Par": "1.90" },
        
        total_gols: { 
            "Mais 0.5": "1.05", "Menos 0.5": "8.00",
            "Mais 1.5": "1.30", "Menos 1.5": "3.20",
            "Mais 2.5": "1.90", "Menos 2.5": "1.80",
            "Mais 3.5": "3.10", "Menos 3.5": "1.30"
        },
        
        gols_times: {
            "Casa +0.5": calc(1.2), "Casa +1.5": calc(C*1.5),
            "Fora +0.5": calc(1.2), "Fora +1.5": calc(F*1.5),
            "Casa Vence Zero": calc(C*2.5), "Fora Vence Zero": calc(F*2.5)
        },

        tempos: {
            "Vencedor 1ºT": { "1": calc(C+1), "X": "2.10", "2": calc(F+1) },
            "Vencedor 2ºT": { "1": calc(C+0.5), "X": "2.40", "2": calc(F+0.5) },
            "Ambos Marcam 1ºT": { "Sim": "4.50", "Não": "1.15" },
            "Ambos Marcam 2ºT": { "Sim": "3.50", "Não": "1.25" },
            "Gol nos 2 Tempos": { "Casa": calc(C*2), "Fora": calc(F*2) }
        },

        intervalos: {
            "Gol 0-10 min": "4.50", "Gol 11-20 min": "4.80", 
            "Gol 81-90 min": "2.50", "Sem Gols": "9.00"
        },

        placar_exato: {
            "1-0": calc(C*3), "2-0": calc(C*4), "2-1": calc(C*5), "3-0": calc(C*8),
            "0-1": calc(F*3), "0-2": calc(F*4), "1-2": calc(F*5), "0-3": calc(F*8),
            "0-0": "8.00", "1-1": "6.00", "2-2": "14.00"
        },

        escanteios: {
            "Mais 8.5": "1.70", "Menos 8.5": "2.00",
            "Mais 9.5": "1.95", "Menos 9.5": "1.75",
            "Mais 10.5": "2.40", "Menos 10.5": "1.50",
            "1x2 Escanteios": { "1": "1.60", "X": "8.00", "2": "2.30" }
        },
        
        handicap: { "Casa -1": calc(C*2.5), "Fora +1": calc(1.40) }
    };
}

// ROTAS DE LOGIN/ADMIN PADRÃO (MANTIDAS)
app.get('/api/admin/resumo', async (req, res) => { try { const f = await pool.query(`SELECT COUNT(*) as t, SUM(valor) as e, SUM(retorno) as r FROM bilhetes`); const u = await pool.query(`SELECT codigo, valor, retorno, data FROM bilhetes ORDER BY data DESC LIMIT 10`); res.json({ caixa: { total: f.rows[0].t, entrada: `R$ ${parseFloat(f.rows[0].e||0).toFixed(2)}`, risco: `R$ ${parseFloat(f.rows[0].r||0).toFixed(2)}` }, ultimos: u.rows }); } catch (e) { res.status(500).json({ erro: "Erro" }); } });
app.post('/api/login', async (req, res) => { res.json({sucesso:false}); });
app.listen(process.env.PORT || 3000, () => console.log("🔥 Server V39 On!"));

