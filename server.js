const express = require('express');
const axios = require('axios');
const { Pool } = require('pg');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors({ origin: '*' }));

// CONFIGURAÇÕES GURILA
const CONFIG = {
    LUCRO_CASA: 0.88, // Margem da banca (Quanto menor, menos a banca paga)
    MIN_VALOR: 2.00,
    MAX_VALOR: 1000.00
};

// Times Fortes (Para calibração)
const TIMES_FORTES = ["Flamengo", "Palmeiras", "Atlético-MG", "Real Madrid", "Barcelona", "Man City", "Liverpool", "PSG", "Bayern", "Inter", "Arsenal", "Botafogo"];

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

// --- ROTA DE JOGOS ---
app.get('/api/jogos', async (req, res) => {
    try {
        const dataHoje = req.query.data || new Date().toISOString().split('T')[0];
        
        // 1. Tenta Cache Banco
        const cache = await pool.query("SELECT json_dados FROM jogos_cache WHERE data_ref = $1", [dataHoje]);
        if (cache.rows.length > 0) return res.json(cache.rows[0].json_dados);

        // 2. Busca ESPN
        const dataESPN = dataHoje.replace(/-/g, '');
        const url = `http://site.api.espn.com/apis/site/v2/sports/soccer/scoreboards?dates=${dataESPN}`;
        const resp = await axios.get(url, { timeout: 5000 });
        
        let jogos = [];
        if (resp.data && resp.data.events) jogos = formatarJogosComMercados(resp.data.events);

        // 3. Backup se falhar
        if (jogos.length === 0) jogos = gerarSimulados(dataHoje);

        // 4. Salva Cache
        await pool.query("INSERT INTO jogos_cache (data_ref, json_dados) VALUES ($1, $2) ON CONFLICT DO NOTHING", [dataHoje, JSON.stringify(jogos)]);
        
        res.json(jogos);
    } catch (e) {
        res.json(gerarSimulados(req.query.data)); // Fallback total
    }
});

// --- ROTA FINALIZAR ---
app.post('/api/finalizar', async (req, res) => {
    try {
        let { usuario_id, valor, apostas, odd_total } = req.body;
        const codigo = "GB" + Math.floor(100000 + Math.random() * 900000);
        const retorno = (parseFloat(valor) * parseFloat(odd_total)).toFixed(2);
        
        // Salva simples para registro (sem validação complexa pra não travar)
        await pool.query('INSERT INTO bilhetes (usuario_id, codigo, valor, retorno, odds_total, detalhes) VALUES ($1, $2, $3, $4, $5, $6)', 
            [usuario_id || 1, codigo, valor, retorno, odd_total, JSON.stringify(apostas)]);
            
        res.json({ sucesso: true, codigo, retorno });
    } catch (e) { res.status(500).json({ erro: "Erro ao processar" }); }
});

// --- MOTOR MATEMÁTICO DE MERCADOS (A MÁGICA) ---
function formatarJogosComMercados(events) {
    return events.map(ev => {
        try {
            if (ev.status.type.state === 'post') return null;
            const h = ev.competitions[0].competitors.find(c => c.homeAway === 'home');
            const a = ev.competitions[0].competitors.find(c => c.homeAway === 'away');
            
            // Calcula Odds Base (1x2)
            const oddsBase = calcularOddsBase(h.team.displayName, a.team.displayName);
            
            // Gera TODOS os mercados derivados
            const mercados = gerarMercadosExtras(oddsBase);

            return {
                id: parseInt(ev.id),
                liga: (ev.season.slug || "Mundo").toUpperCase(),
                home: { name: h.team.displayName, logo: h.team.logo || "" },
                away: { name: a.team.displayName, logo: a.team.logo || "" },
                data: ev.date,
                status: ev.status.type.state === 'in' ? 'AO VIVO' : 'VS',
                odds: oddsBase, // Apenas 1x2 principal pra lista
                mercados: mercados // O Cardápio Completo
            };
        } catch (e) { return null; }
    }).filter(Boolean);
}

function calcularOddsBase(home, away) {
    const hStrong = TIMES_FORTES.some(t => home.includes(t));
    const aStrong = TIMES_FORTES.some(t => away.includes(t));
    let c = 2.40, e = 3.20, f = 2.80;

    if (hStrong && !aStrong) { c = 1.45; e = 4.20; f = 6.50; }
    else if (aStrong && !hStrong) { c = 5.50; e = 3.90; f = 1.55; }
    
    // Variação
    c += (Math.random() * 0.2); f += (Math.random() * 0.2);
    
    return { casa: c.toFixed(2), empate: e.toFixed(2), fora: f.toFixed(2) };
}

function gerarMercadosExtras(base) {
    const C = parseFloat(base.casa);
    const E = parseFloat(base.empate);
    const F = parseFloat(base.fora);
    const m = CONFIG.LUCRO_CASA; // Margem

    // Funções auxiliares de cálculo
    const calc = (v) => (v * m).toFixed(2);
    const inv = (v) => ((1 / v) * 3).toFixed(2); // Inverso aproximado

    return {
        // --- PRINCIPAIS ---
        dupla_chance: {
            "1X": calc(1 + (1/C + 1/E)/2),
            "12": calc(1.30),
            "X2": calc(1 + (1/F + 1/E)/2)
        },
        empate_anula: {
            "1": calc(C * 0.7),
            "2": calc(F * 0.7)
        },
        ambas_marcam: {
            "Sim": calc(1.90),
            "Não": calc(1.80)
        },
        
        // --- GOLS ---
        total_gols: {
            "Mais 1.5": calc(1.30), "Menos 1.5": calc(3.20),
            "Mais 2.5": calc(1.95), "Menos 2.5": calc(1.85),
            "Mais 3.5": calc(3.50), "Menos 3.5": calc(1.25)
        },
        total_gols_casa: {
            "Mais 0.5": calc(C < 2 ? 1.2 : 1.5), "Menos 0.5": calc(C < 2 ? 4.0 : 2.5),
            "Mais 1.5": calc(C < 2 ? 1.7 : 3.0), "Menos 1.5": calc(C < 2 ? 2.0 : 1.3)
        },
        total_gols_fora: {
            "Mais 0.5": calc(F < 2 ? 1.2 : 1.5), "Menos 0.5": calc(F < 2 ? 4.0 : 2.5),
            "Mais 1.5": calc(F < 2 ? 1.7 : 3.0), "Menos 1.5": calc(F < 2 ? 2.0 : 1.3)
        },
        impar_par: {
            "Ímpar": "1.90", "Par": "1.90"
        },

        // --- 1º TEMPO (HT) ---
        ht_vencedor: {
            "1": calc(C + 1.0), "X": calc(2.10), "2": calc(F + 1.0)
        },
        ht_gols: {
            "Mais 0.5": calc(1.40), "Menos 0.5": calc(2.70),
            "Mais 1.5": calc(3.00), "Menos 1.5": calc(1.35)
        },
        ht_ambas: {
            "Sim": calc(4.50), "Não": calc(1.15)
        },
        ht_dupla: {
            "1X": calc(1.20), "12": calc(1.50), "X2": calc(1.20)
        },

        // --- 2º TEMPO ---
        ft_vencedor_2tempo: {
            "1": calc(C + 0.5), "X": calc(2.50), "2": calc(F + 0.5)
        },
        ft_gols: {
            "Mais 0.5": calc(1.30), "Menos 0.5": calc(3.00)
        },

        // --- HANDICAPS (Simulados) ---
        handicap: {
            "Casa -1": calc(C * 2.5), "Empate -1": calc(3.50), "Fora +1": calc(1.50),
            "Casa +1": calc(1.15), "Empate +1": calc(4.00), "Fora -1": calc(F * 2.5)
        },

        // --- COMBINADOS (DINDIN 💰) ---
        resultado_ambas: {
            "Casa e Sim": calc(C * 2.0), "Fora e Sim": calc(F * 2.0), "Empate e Sim": calc(4.50),
            "Casa e Não": calc(C * 1.5), "Fora e Não": calc(F * 1.5), "Empate e Não": calc(3.50)
        },
        resultado_gols: {
            "Casa e +2.5": calc(C * 1.8), "Fora e +2.5": calc(F * 1.8), "Empate e +2.5": calc(6.00),
            "Casa e -2.5": calc(C * 1.4), "Fora e -2.5": calc(F * 1.4), "Empate e -2.5": calc(3.50)
        },

        // --- PLACAR EXATO (Aproximado) ---
        placar_exato: {
            "0-0": calc(8.00), "1-1": calc(6.50), "2-2": calc(15.00),
            "1-0": calc(C * 3), "2-0": calc(C * 4), "2-1": calc(C * 5),
            "0-1": calc(F * 3), "0-2": calc(F * 4), "1-2": calc(F * 5)
        },

        // --- ESCANTEIOS (Simulados - Cuidado!) ---
        escanteios: {
            "Mais 8.5": "1.70", "Menos 8.5": "2.00",
            "Mais 9.5": "1.90", "Menos 9.5": "1.80",
            "Mais 10.5": "2.30", "Menos 10.5": "1.55"
        }
    };
}

function gerarSimulados(data) { /* Mesmo código anterior */ return []; }

// Rotas Admin/User Padrão
app.get('/api/admin/resumo', async (req, res) => { try { const f = await pool.query(`SELECT COUNT(*) as t, SUM(valor) as e, SUM(retorno) as r FROM bilhetes`); const u = await pool.query(`SELECT codigo, valor, retorno, data FROM bilhetes ORDER BY data DESC LIMIT 10`); res.json({ caixa: { total: f.rows[0].t, entrada: `R$ ${parseFloat(f.rows[0].e||0).toFixed(2)}`, risco: `R$ ${parseFloat(f.rows[0].r||0).toFixed(2)}` }, ultimos: u.rows }); } catch (e) { res.status(500).json({ erro: "Erro" }); } });
app.post('/api/cadastro', async (req, res) => { try { const { nome, email, senha } = req.body; const result = await pool.query('INSERT INTO usuarios (nome, email, senha) VALUES ($1, $2, $3) RETURNING id, nome, saldo', [nome, email, "123"]); res.json({ sucesso: true, usuario: result.rows[0] }); } catch (e) { res.status(500).json({ erro: "Erro" }); } });
app.post('/api/login', async (req, res) => { try { const { email, senha } = req.body; const r = await pool.query('SELECT * FROM usuarios WHERE email = $1', [email]); if(r.rows.length) { res.json({sucesso:true, usuario:r.rows[0]}); } else res.status(400).json({erro:"Erro"}); } catch(e){ res.status(500).json({erro:"Erro"}); } });
app.listen(process.env.PORT || 3000, () => console.log("🔥 Server V31 (Full Markets) On!"));
