const express = require('express');
const axios = require('axios');
const { Pool } = require('pg');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// --- FUNÇÃO QUE CRIA A TABELA SOZINHA (O PULTO DO GATO) ---
async function inicializarBanco() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS bilhetes (
                id SERIAL PRIMARY KEY,
                codigo VARCHAR(10) UNIQUE,
                valor DECIMAL(10,2),
                retorno_potencial DECIMAL(10,2),
                jogo_id VARCHAR(50),
                times VARCHAR(255),
                palpite VARCHAR(50),
                status VARCHAR(20) DEFAULT 'pendente',
                horario_jogo TIMESTAMP,
                criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log("✅ BANCO DE DADOS PRONTO!");
    } catch (err) {
        console.error("❌ ERRO NO BANCO:", err.message);
    }
}
inicializarBanco();

// --- CONFIGURAÇÃO DA BANCA ---
const MARGEM_LUCRO = 0.85; 
const GANHO_MAXIMO = 2500.00;

app.get('/api/jogos', async (req, res) => {
    try {
        const resp = await axios.get('https://v3.football.api-sports.io/fixtures?league=71&season=2024&next=15', {
            headers: { 'x-rapidapi-key': process.env.API_FOOTBALL_KEY }
        });

        const jogos = resp.data.response.map(j => ({
            id: j.fixture.id,
            times: `${j.teams.home.name} x ${j.teams.away.name}`,
            data: j.fixture.date,
            odds: {
                casa: (2.10 * MARGEM_LUCRO).toFixed(2),
                empate: (3.20 * MARGEM_LUCRO).toFixed(2),
                fora: (3.80 * MARGEM_LUCRO).toFixed(2)
            }
        }));
        res.json(jogos);
    } catch (e) { 
        res.status(500).json({ erro: "Erro ao buscar jogos" }); 
    }
});

app.post('/api/finalizar', async (req, res) => {
    const { valor, palpite, jogoId, times, horario, odd } = req.body;
    const codigo = Math.random().toString(36).substring(2, 8).toUpperCase();
    let retorno = (valor * odd);
    if (retorno > GANHO_MAXIMO) retorno = GANHO_MAXIMO;

    try {
        await pool.query(
            'INSERT INTO bilhetes (codigo, valor, retorno_potencial, jogo_id, times, palpite, status, horario_jogo) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
            [codigo, valor, retorno.toFixed(2), jogoId, times, palpite, 'pendente', horario]
        );
        res.json({ codigo, retorno: retorno.toFixed(2) });
    } catch (e) { 
        res.status(500).json({ erro: "Erro ao salvar bilhete" }); 
    }
});

app.listen(process.env.PORT || 3000, () => console.log("🚀 Servidor Rodando!"));
