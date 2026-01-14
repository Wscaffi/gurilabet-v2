const express = require('express');
const axios = require('axios');
const { Pool } = require('pg');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
app.use(express.json());
app.use(cors({ origin: '*' }));

const pool = new Pool({ 
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// Inicialização do Banco
async function initDb() {
    try {
        await pool.query(`CREATE TABLE IF NOT EXISTS usuarios (
            id SERIAL PRIMARY KEY, nome TEXT, email TEXT UNIQUE, senha TEXT, saldo NUMERIC DEFAULT 0.00
        )`);
        await pool.query(`CREATE TABLE IF NOT EXISTS bilhetes (
            id SERIAL PRIMARY KEY, usuario_id INTEGER, codigo TEXT UNIQUE, 
            valor NUMERIC, retorno NUMERIC, odds_total NUMERIC, status TEXT DEFAULT 'pendente', 
            detalhes JSONB, data TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`);
        console.log("✅ Banco Gurila Bet Conectado!");
    } catch (e) { console.error("Erro Banco:", e.message); }
}
initDb();

// ROTA DE JOGOS (COM MERCADOS EXTRAS PARA O NOVO LAYOUT)
app.get('/api/jogos', async (req, res) => {
    try {
        const headers = { 
            'x-rapidapi-key': process.env.API_FOOTBALL_KEY,
            'x-rapidapi-host': 'v3.football.api-sports.io'
        };
        
        let url = '';
        if (req.query.aovivo === 'true') {
            url = `https://v3.football.api-sports.io/fixtures?live=all`;
        } else {
            const hoje = new Date().toISOString().split('T')[0];
            const dataFiltro = req.query.data || hoje;
            url = `https://v3.football.api-sports.io/fixtures?date=${dataFiltro}`;
        }

        const resp = await axios.get(url, { headers, timeout: 15000 });
        let fixtures = resp.data.response;
        if (!fixtures) fixtures = [];

        res.json(formatar(fixtures));
    } catch (e) {
        res.status(500).json({ erro: e.message });
    }
});

function formatar(data) {
    const agora = new Date();
    return data.map(j => {
        const dataJogo = new Date(j.fixture.date);
        const status = j.fixture.status.short;
        
        // Travas de Segurança
        const isFuturo = status === 'NS' && dataJogo > agora;
        const isAoVivo = ['1H', '2H', 'HT', 'ET', 'P', 'BT'].includes(status);
        
        // Se não for futuro e não for ao vivo, descarta (retorna null)
        if (!isFuturo && !isAoVivo) return null;

        return {
            id: j.fixture.id,
            liga: j.league.name,
            logo_liga: j.league.logo,
            pais: j.league.country,
            bandeira_pais: j.league.flag || j.league.logo,
            home: { name: j.teams.home.name, logo: j.teams.home.logo },
            away: { name: j.teams.away.name, logo: j.teams.away.logo },
            data: j.fixture.date,
            status: status,
            ativo: true,
            odds: { 
                casa: (1.5 + Math.random()).toFixed(2), 
                empate: (3.0 + Math.random()).toFixed(2), 
                fora: (2.2 + Math.random() * 2).toFixed(2) 
            },
            // MERCADOS EXTRAS (ESSENCIAL PARA O BOTÃO + FUNCIONAR)
            mercados: {
                dupla_chance: {
                    casa_empate: (1.20 + Math.random() * 0.1).toFixed(2),
                    casa_fora: (1.25 + Math.random() * 0.1).toFixed(2),
                    empate_fora: (1.60 + Math.random() * 0.3).toFixed(2)
                },
                ambas_marcam: {
                    sim: (1.70 + Math.random() * 0.3).toFixed(2),
                    nao: (1.90 + Math.random() * 0.3).toFixed(2)
                },
                total_gols: {
                    mais_15: (1.25 + Math.random() * 0.1).toFixed(2), menos_15: (3.50).toFixed(2),
                    mais_25: (1.80 + Math.random() * 0.5).toFixed(2), menos_25: (1.90).toFixed(2),
                    mais_35: (3.20 + Math.random()).toFixed(2), menos_35: (1.30).toFixed(2)
                },
                placar_exato: {
                    "1-0": (6.00 + Math.random()).toFixed(2), "2-0": (8.50 + Math.random()).toFixed(2),
                    "2-1": (9.00 + Math.random()).toFixed(2), "0-0": (8.00 + Math.random()).toFixed(2),
                    "0-1": (7.50 + Math.random()).toFixed(2), "1-1": (6.50 + Math.random()).toFixed(2)
                },
                intervalo_final: { 
                    "Casa/Casa": (2.50 + Math.random()).toFixed(2),
                    "Empate/Empate": (4.50 + Math.random()).toFixed(2),
                    "Fora/Fora": (3.80 + Math.random()).toFixed(2)
                },
                handicap: {
                    "Casa -1": (2.80 + Math.random()).toFixed(2),
                    "Empate -1": (3.40 + Math.random()).toFixed(2),
                    "Fora +1": (1.45 + Math.random()).toFixed(2)
                },
                escanteios: {
                    mais_8: (1.50 + Math.random()).toFixed(2),
                    mais_10: (2.10 + Math.random()).toFixed(2),
                    menos_10: (1.65 + Math.random()).toFixed(2)
                }
            }
        };
    }).filter(j => j !== null);
}

// ROTA DE VALIDAÇÃO (ADMIN) - ESSENCIAL PARA O RODAPÉ
app.get('/api/bilhete/:codigo', async (req, res) => {
    try {
        const { codigo } = req.params;
        const result = await pool.query(`
            SELECT b.*, u.nome as cliente 
            FROM bilhetes b 
            LEFT JOIN usuarios u ON b.usuario_id = u.id 
            WHERE b.codigo = $1
        `, [codigo]);
        
        if(result.rows.length > 0) {
            res.json({ sucesso: true, bilhete: result.rows[0] });
        } else {
            res.json({ sucesso: false, erro: "Bilhete não encontrado" });
        }
    } catch(e) { res.status(500).json({ erro: e.message }); }
});

app.post('/api/cadastro', async (req, res) => {
    const { nome, email, senha } = req.body;
    const hash = crypto.createHash('sha256').update(senha).digest('hex');
    try {
        const result = await pool.query(
            'INSERT INTO usuarios (nome, email, senha) VALUES ($1, $2, $3) RETURNING id, nome, saldo',
            [nome, email, hash]
        );
        res.json({ sucesso: true, usuario: result.rows[0] });
    } catch (e) { res.status(400).json({ erro: "E-mail já cadastrado." }); }
});

app.post('/api/finalizar', async (req, res) => {
    const { usuario_id, valor, apostas, odd_total } = req.body;
    
    // Trava de Limite de Jogos
    if (apostas.length > 10) return res.status(400).json({ erro: "Limite de 10 jogos excedido." });

    const codigo = "GB" + Math.floor(100000 + Math.random() * 900000);
    
    // Trava de Valor Máximo
    let retornoCalc = (valor * odd_total);
    if(retornoCalc > 2500) retornoCalc = 2500.00;
    const retornoFinal = parseFloat(retornoCalc).toFixed(2);
    
    // Tenta usar ID 1 se não tiver usuário logado (Aposta Avulsa)
    const idUser = usuario_id || 1;

    try {
        await pool.query(
            'INSERT INTO bilhetes (usuario_id, codigo, valor, retorno, odds_total, detalhes) VALUES ($1, $2, $3, $4, $5, $6)',
            [idUser, codigo, valor, retornoFinal, odd_total, JSON.stringify(apostas)]
        );
        res.json({ sucesso: true, codigo, retorno: retornoFinal });
    } catch (e) { 
        console.error(e);
        // Tenta criar usuário genérico se falhar
        try {
            await pool.query("INSERT INTO usuarios (id, nome, email, senha) VALUES (1, 'Cliente Balcão', 'cliente@gurila.com', '123') ON CONFLICT DO NOTHING");
            await pool.query(
                'INSERT INTO bilhetes (usuario_id, codigo, valor, retorno, odds_total, detalhes) VALUES ($1, $2, $3, $4, $5, $6)',
                [1, codigo, valor, retornoFinal, odd_total, JSON.stringify(apostas)]
            );
            res.json({ sucesso: true, codigo, retorno: retornoFinal });
        } catch(err) {
            res.status(500).json({ erro: "Erro ao processar aposta" });
        }
    }
});

app.listen(process.env.PORT || 3000);
