const express = require('express');
const axios = require('axios');
const { Pool } = require('pg');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

// Conexão com o Banco de Dados
const pool = new Pool({ 
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// Criar tabela automaticamente se não existir
async function initDb() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS bilhetes (
                id SERIAL PRIMARY KEY,
                codigo TEXT UNIQUE,
                valor NUMERIC,
                retorno_potencial NUMERIC,
                times TEXT,
                palpite TEXT,
                status TEXT DEFAULT 'pendente',
                criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log("✅ Banco de dados pronto!");
    } catch (err) {
        console.error("❌ Erro ao iniciar banco:", err.message);
    }
}
initDb();

// Rota para buscar jogos (Próximos 15 jogos de qualquer liga)
app.get('/api/jogos', async (req, res) => {
    try {
        const resp = await axios.get('https://v3.football.api-sports.io/fixtures?next=15', {
            headers: { 'x-rapidapi-key': process.env.API_FOOTBALL_KEY }
        });

        const jogos = resp.data.response.map(j => ({
            id: j.fixture.id,
            times: `${j.teams.home.name} x ${j.teams.away.name}`,
            data: j.fixture.date,
            odds: {
                casa: "1.95",
                empate: "3.40",
                fora: "4.10"
            }
        }));
        res.json(jogos);
    } catch (error) {
        console.error("Erro na API:", error.message);
        res.status(500).json({ erro: "Erro ao carregar jogos" });
    }
});

// Rota para salvar aposta
app.post('/api/finalizar', async (req, res) => {
    try {
        const { valor, palpite, times, odd } = req.body;
        const codigo = Math.random().toString(36).substring(2, 8).toUpperCase();
        const retorno = (valor * odd).toFixed(2);

        await pool.query(
            'INSERT INTO bilhetes (codigo, valor, retorno_potencial, times, palpite) VALUES ($1, $2, $3, $4, $5)',
            [codigo, valor, retorno, times, palpite]
        );

        res.json({ codigo, retorno });
    } catch (error) {
        console.error("Erro ao salvar:", error.message);
        res.status(500).json({ erro: "Erro no servidor" });
    }
});

// Iniciar servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Motor rodando na porta ${PORT}`));
app.get('/teste', (req, res) => res.send("O GORILA ESTÁ VIVO"));
