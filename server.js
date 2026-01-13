const express = require('express');
const axios = require('axios');
const { Pool } = require('pg');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// FUNÇÃO PARA CRIAR TABELA AUTOMÁTICA
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

// ROTA PARA BUSCAR JOGOS (CORRIGIDA)
app.get('/api/jogos', async (req, res) => {
    try {
        // Buscando os próximos 15 jogos de hoje (Janeiro 2026)
        const resp = await axios.get('https://v3.football.api-sports.io/fixtures?next=15', {
            headers: { 'x-rapidapi-key': process.env.API_FOOTBALL_KEY }
        });

        const jogos = resp.data.response.map(j => ({
            id: j.fixture.id,
            times: `${j.teams.home.name} x ${j.teams.away.name}`,
            data: j.fixture.date,
            odds: {
                casa: (1.85).toFixed(2),
                empate: (3.10).toFixed(2),
                fora: (4.20).toFixed(2)
            }
        }));
        res.json(jogos);
    } catch (error) {
        console.error("Erro na API de Jogos:", error.message);
        res.status(500).json({ erro: "Erro ao buscar jogos" });
    }
});

// ROTA PARA FINALIZAR BILHETE
app.post('/api/finalizar', async (req, res) => {
    try {
        const { valor, palpite, jogoId, times, horario, odd } = req.body;
        const codigo = Math.random().toString(36).substring(2, 8).toUpperCase();
        const retorno = (valor * odd).toFixed(2);

        await pool.query(
            'INSERT INTO bilhetes (codigo, valor, retorno_potencial, jogo_id, times, palpite, status, horario_jogo) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
            [codigo, valor, retorno, jogoId, times, palpite, 'pendente', horario]
        );
        res.json({ codigo, retorno });
    } catch (e) {
        console.error("Erro ao salvar bilhete:", e.message);
        res.status(500).json({ erro: "Erro ao salvar bilhete" });
    }
});

app.listen(process.env.PORT || 3000, () => {
    console.log("🚀 MOTOR RODANDO NA PORTA " + (process.env.PORT || 3000));
});
