const express = require('express');
const axios = require('axios');
const { Pool } = require('pg');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
app.use(express.json());
app.use(cors({ origin: '*' }));

// Configuração de banco com limite de tempo para não travar o site
const pool = new Pool({ 
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 2000 // Se não conectar em 2s, ele desiste e foca nos jogos
});

// Rota de Jogos - EXATAMENTE a que funcionou antes
app.get('/api/jogos', async (req, res) => {
    try {
        console.log("Tentando requisitar API-Sports...");
        const headers = { 
            'x-rapidapi-key': process.env.API_FOOTBALL_KEY,
            'x-rapidapi-host': 'v3.football.api-sports.io'
        };
        
        // Chamada direta para os próximos jogos
        const resp = await axios.get('https://v3.football.api-sports.io/fixtures?next=50', { 
            headers,
            timeout: 15000 // Espera até 15 segundos pela API
        });

        if (!resp.data.response || resp.data.response.length === 0) {
            return res.json([]);
        }

        const formatados = resp.data.response.map(j => ({
            id: j.fixture.id,
            liga: j.league.name,
            pais: j.league.country,
            bandeira: j.league.logo,
            home: { name: j.teams.home.name, logo: j.teams.home.logo },
            away: { name: j.teams.away.name, logo: j.teams.away.logo },
            data: j.fixture.date,
            odds: { 
                casa: (1.5 + Math.random()).toFixed(2), 
                empate: (3.1 + Math.random()).toFixed(2), 
                fora: (2.4 + Math.random() * 2).toFixed(2) 
            }
        }));

        console.log("Jogos carregados com sucesso!");
        res.json(formatados);
    } catch (e) {
        console.error("Erro na Requisição:", e.message);
        res.status(500).json([]);
    }
});

// Cadastro e Login (Mantidos conforme solicitado)
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

app.listen(process.env.PORT || 3000, () => console.log("Motor Gurila Bet Online 🚀"));
