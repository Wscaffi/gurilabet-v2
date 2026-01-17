const express = require('express');
const axios = require('axios');
const { Pool } = require('pg');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors({ origin: '*' }));

// CONFIGURAÇÕES GURILA
const CONFIG = {
    LUCRO_CASA: 0.88, 
    MIN_VALOR: 2.00,
    MAX_VALOR: 1000.00
};

const TIMES_FORTES = ["Flamengo", "Palmeiras", "Atlético-MG", "Real Madrid", "Barcelona", "Man City", "Liverpool", "PSG", "Bayern", "Inter", "Arsenal", "Botafogo", "São Paulo", "Corinthians"];

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

// INICIALIZAÇÃO COM LIMPEZA DE CACHE (PARA CORRIGIR O BUG)
async function initDb() {
    try {
        await pool.query(`CREATE TABLE IF NOT EXISTS usuarios (id SERIAL PRIMARY KEY, nome TEXT, email TEXT UNIQUE, senha TEXT, saldo NUMERIC DEFAULT 0.00)`);
        await pool.query(`CREATE TABLE IF NOT EXISTS bilhetes (id SERIAL PRIMARY KEY, usuario_id INTEGER, codigo TEXT UNIQUE, valor NUMERIC, retorno NUMERIC, odds_total NUMERIC, status TEXT DEFAULT 'pendente', detalhes JSONB, data TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
        
        // RECRIAR TABELA DE CACHE PARA GARANTIR ESTRUTURA NOVA
        await pool.query(`DROP TABLE IF EXISTS jogos_cache`); 
        await pool.query(`CREATE TABLE jogos_cache (id SERIAL PRIMARY KEY, data_ref TEXT UNIQUE, json_dados JSONB, atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
        
        console.log("✅ Servidor V32 Online - Cache Limpo e Pronto!");
    } catch (e) { console.error("Erro DB:", e.message); }
}
initDb();

// --- ROTA DE JOGOS ---
app.get('/api/jogos', async (req, res) => {
    const dataHoje = req.query.data || new Date().toISOString().split('T')[0];
    
    try {
        // 1. Tenta Cache Banco
        const cache = await pool.query("SELECT json_dados FROM jogos_cache WHERE data_ref = $1", [dataHoje]);
        if (cache.rows.length > 0) return res.json(cache.rows[0].json_dados);

        // 2. Busca ESPN
        console.log("Buscando na ESPN...");
        const dataESPN = dataHoje.replace(/-/g, '');
        const url = `http://site.api.espn.com/apis/site/v2/sports/soccer/scoreboards?dates=${dataESPN}`;
        const resp = await axios.get(url, { timeout: 4000 });
        
        let jogos = [];
        if (resp.data && resp.data.events) {
            jogos = formatarJogosComMercados(resp.data.events);
        }

        // 3. SE A ESPN FALHAR OU VIER VAZIA -> ATIVA O GERADOR DE EMERGÊNCIA
        if (jogos.length === 0) {
            console.log("⚠️ ESPN vazia/falhou. Gerando jogos simulados...");
            jogos = gerarSimulados(dataHoje);
        }

        // 4. Salva Cache
        if(jogos.length > 0) {
            await pool.query("INSERT INTO jogos_cache (data_ref, json_dados) VALUES ($1, $2) ON CONFLICT (data_ref) DO UPDATE SET json_dados = $2", [dataHoje, JSON.stringify(jogos)]);
        }
        
        res.json(jogos);
    } catch (e) {
        console.error("Erro Geral:", e.message);
        // Fallback final
        res.json(gerarSimulados(dataHoje)); 
    }
});

app.post('/api/finalizar', async (req, res) => {
    try {
        let { usuario_id, valor, apostas, odd_total } = req.body;
        const codigo = "GB" + Math.floor(100000 + Math.random() * 900000);
        const retorno = (parseFloat(valor) * parseFloat(odd_total)).toFixed(2);
        
        await pool.query('INSERT INTO bilhetes (usuario_id, codigo, valor, retorno, odds_total, detalhes) VALUES ($1, $2, $3, $4, $5, $6)', 
            [usuario_id || 1, codigo, valor, retorno, odd_total, JSON.stringify(apostas)]);
            
        res.json({ sucesso: true, codigo, retorno });
    } catch (e) { res.status(500).json({ erro: "Erro ao processar" }); }
});

// --- MOTOR MATEMÁTICO ---
function formatarJogosComMercados(events) {
    return events.map(ev => {
        try {
            if (ev.status.type.state === 'post') return null;
            const h = ev.competitions[0].competitors.find(c => c.homeAway === 'home');
            const a = ev.competitions[0].competitors.find(c => c.homeAway === 'away');
            const oddsBase = calcularOddsBase(h.team.displayName, a.team.displayName);
            
            return {
                id: parseInt(ev.id),
                liga: (ev.season.slug || "Mundo").toUpperCase().replace("-", " "),
                home: { name: h.team.displayName, logo: h.team.logo || "" },
                away: { name: a.team.displayName, logo: a.team.logo || "" },
                data: ev.date,
                status: ev.status.type.state === 'in' ? 'AO VIVO' : 'VS',
                odds: oddsBase,
                mercados: gerarMercadosExtras(oddsBase) // Gera o cardápio completo
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
    
    c += (Math.random() * 0.2); f += (Math.random() * 0.2);
    return { casa: c.toFixed(2), empate: e.toFixed(2), fora: f.toFixed(2) };
}

function gerarMercadosExtras(base) {
    const C = parseFloat(base.casa);
    const m = CONFIG.LUCRO_CASA;
    const calc = (v) => (v * m).toFixed(2);

    return {
        dupla_chance: { "1X": calc(1.25), "12": calc(1.30), "X2": calc(1.25) },
        empate_anula: { "1": calc(C * 0.7), "2": calc(parseFloat(base.fora) * 0.7) },
        ambas_marcam: { "Sim": calc(1.90), "Não": calc(1.80) },
        total_gols: { "Mais 1.5": calc(1.30), "Menos 1.5": calc(3.20), "Mais 2.5": calc(1.95), "Menos 2.5": calc(1.85) },
        ht_vencedor: { "1": calc(C + 1.0), "X": calc(2.10), "2": calc(parseFloat(base.fora) + 1.0) },
        ft_vencedor_2tempo: { "1": calc(C + 0.5), "X": calc(2.50), "2": calc(parseFloat(base.fora) + 0.5) },
        placar_exato: { "1-0": calc(C * 3), "2-0": calc(C * 4), "2-1": calc(C * 5), "0-1": calc(parseFloat(base.fora) * 3) },
        handicap: { "Casa -1": calc(C * 2.5), "Fora +1": calc(1.50) }
    };
}

// --- GERADOR DE EMERGÊNCIA (O SALVA-VIDAS) ---
function gerarSimulados(dataStr) {
    const lista = [];
    const baseDate = new Date(dataStr);
    baseDate.setHours(13, 0, 0);

    const times = [
        ["Flamengo", "Vasco"], ["Palmeiras", "São Paulo"], ["Corinthians", "Santos"], 
        ["Real Madrid", "Barcelona"], ["Liverpool", "Man City"], ["PSG", "Marseille"],
        ["Boca Juniors", "River Plate"], ["Inter Miami", "LA Galaxy"], ["Grêmio", "Inter"]
    ];

    times.forEach((par, i) => {
        const horario = new Date(baseDate);
        horario.setHours(baseDate.getHours() + (i % 5)); // Espalha horários
        
        const oddsBase = calcularOddsBase(par[0], par[1]);
        
        lista.push({
            id: 9000 + i,
            liga: "JOGOS EM DESTAQUE (SIMULADO)",
            home: { name: par[0], logo: "https://cdn-icons-png.flaticon.com/512/183/183345.png" },
            away: { name: par[1], logo: "https://cdn-icons-png.flaticon.com/512/183/183345.png" },
            data: horario.toISOString(),
            status: "VS",
            odds: oddsBase,
            mercados: gerarMercadosExtras(oddsBase)
        });
    });
    return lista;
}

// Rotas Padrão
app.get('/api/admin/resumo', async (req, res) => { try { const f = await pool.query(`SELECT COUNT(*) as t, SUM(valor) as e, SUM(retorno) as r FROM bilhetes`); const u = await pool.query(`SELECT codigo, valor, retorno, data FROM bilhetes ORDER BY data DESC LIMIT 10`); res.json({ caixa: { total: f.rows[0].t, entrada: `R$ ${parseFloat(f.rows[0].e||0).toFixed(2)}`, risco: `R$ ${parseFloat(f.rows[0].r||0).toFixed(2)}` }, ultimos: u.rows }); } catch (e) { res.status(500).json({ erro: "Erro" }); } });
app.post('/api/cadastro', async (req, res) => { try { const { nome, email, senha } = req.body; const result = await pool.query('INSERT INTO usuarios (nome, email, senha) VALUES ($1, $2, $3) RETURNING id, nome, saldo', [nome, email, "123"]); res.json({ sucesso: true, usuario: result.rows[0] }); } catch (e) { res.status(500).json({ erro: "Erro" }); } });
app.post('/api/login', async (req, res) => { try { const { email, senha } = req.body; const r = await pool.query('SELECT * FROM usuarios WHERE email = $1', [email]); if(r.rows.length) { res.json({sucesso:true, usuario:r.rows[0]}); } else res.status(400).json({erro:"Erro"}); } catch(e){ res.status(500).json({erro:"Erro"}); } });
app.listen(process.env.PORT || 3000, () => console.log("🔥 Server V32 (Emergency Fix) On!"));
