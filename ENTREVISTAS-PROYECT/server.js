const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const nodemailer = require('nodemailer');
const { Resend } = require('resend');
const { runMigrations } = require('./migrations');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Configuración de PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

// Ejecutar migraciones al iniciar
runMigrations()
  .then(() => console.log('✅ Base de datos inicializada'))
  .catch(error => console.error('❌ Error al inicializar BD:', error));

// Configuración de servicio de correo
let emailService = null;
let emailServiceType = 'none';

// Intentar configurar Resend primero (preferido para Render)
if (process.env.RESEND_API_KEY) {
  try {
    emailService = new Resend(process.env.RESEND_API_KEY);
    emailServiceType = 'resend';
    console.log('✅ Servicio de correo configurado: Resend');
  } catch (error) {
    console.error('❌ Error al configurar Resend:', error.message);
  }
}

// Si no hay Resend, intentar con Nodemailer/Gmail
if (!emailService && process.env.EMAIL_USER && process.env.EMAIL_PASS) {
  const emailDomain = process.env.EMAIL_USER.split('@')[1]?.toLowerCase();
  
  let emailConfig = {
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS
    },
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 15000,
    pool: false,
    logger: false,
    debug: false
  };

  if (emailDomain?.includes('gmail')) {
    emailConfig.host = 'smtp.gmail.com';
    emailConfig.port = 465;
    emailConfig.secure = true;
    emailConfig.tls = {
      rejectUnauthorized: false,
      minVersion: 'TLSv1.2'
    };
  } else if (emailDomain?.includes('outlook') || emailDomain?.includes('hotmail') || emailDomain?.includes('live')) {
    emailConfig.host = 'smtp.office365.com';
    emailConfig.port = 587;
    emailConfig.secure = false;
    emailConfig.tls = {
      ciphers: 'SSLv3'
    };
  } else if (process.env.SMTP_HOST) {
    emailConfig.host = process.env.SMTP_HOST;
    emailConfig.port = parseInt(process.env.SMTP_PORT) || 587;
    emailConfig.secure = process.env.SMTP_SECURE === 'true';
  } else {
    emailConfig.host = `smtp.${emailDomain}`;
    emailConfig.port = 587;
    emailConfig.secure = false;
  }

  emailService = nodemailer.createTransport(emailConfig);
  emailServiceType = 'smtp';
  
  emailService.verify((error, success) => {
    if (error) {
      console.error('❌ Error al conectar con SMTP:', error.message);
      console.log('📧 Configuración:', {
        host: emailConfig.host,
        port: emailConfig.port,
        user: process.env.EMAIL_USER
      });
      console.log('⚠️ Los correos NO se enviarán.');
      console.log('💡 Considera usar Resend: https://resend.com (gratis, 3000 correos/mes)');
      emailService = null;
      emailServiceType = 'none';
    } else {
      console.log('✅ Servidor de correo SMTP listo');
    }
  });
}

if (!emailService) {
  console.log('⚠️ Servicio de correo NO configurado. Los correos no se enviarán.');
  console.log('💡 Para habilitar correos:');
  console.log('   - Opción 1 (Recomendado): Agregar RESEND_API_KEY');
  console.log('   - Opción 2: Configurar EMAIL_USER y EMAIL_PASS');
}

// Función para enviar correo (soporta Resend y SMTP)
async function enviarCorreo(correo, asunto, contenido) {
  try {
    if (!emailService) {
      console.log('⚠️ Servicio de correo no configurado. Correo no enviado.');
      return;
    }

    if (emailServiceType === 'resend') {
      // Usar Resend
      await emailService.emails.send({
        from: process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev',
        to: correo,
        subject: asunto,
        html: contenido
      });
      console.log('✅ Correo enviado exitosamente a:', correo, '(vía Resend)');
    } else if (emailServiceType === 'smtp') {
      // Usar SMTP (Gmail, etc.)
      await emailService.sendMail({
        from: process.env.EMAIL_USER,
        to: correo,
        subject: asunto,
        html: contenido
      });
      console.log('✅ Correo enviado exitosamente a:', correo, '(vía SMTP)');
    }
  } catch (error) {
    console.error('❌ Error al enviar correo:', error.message);
  }
}

// ============= ENDPOINTS =============

// POST: Crear nueva solicitud de entrevista
app.post('/api/solicitudes', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { nombre, apellidos, celular, correo, fecha_cita, hora_cita } = req.body;

    // Insertar aspirante
    const aspiranteResult = await client.query(
      'INSERT INTO aspirante (nombre, apellidos, celular, correo) VALUES ($1, $2, $3, $4) RETURNING id_aspirante',
      [nombre, apellidos, celular, correo]
    );
    const id_aspirante = aspiranteResult.rows[0].id_aspirante;

    // Insertar solicitud
    const solicitudResult = await client.query(
      'INSERT INTO solicitud (fecha_solicitud, estado, id_aspirante) VALUES (NOW(), $1, $2) RETURNING id_solicitud',
      ['pendiente', id_aspirante]
    );
    const id_solicitud = solicitudResult.rows[0].id_solicitud;

    // Insertar cita (temporal, sin confirmar)
    await client.query(
      'INSERT INTO cita (fecha_cita, hora_cita, id_solicitud) VALUES ($1, $2, $3)',
      [fecha_cita, hora_cita, id_solicitud]
    );

    await client.query('COMMIT');

    // Responder inmediatamente al cliente
    res.status(201).json({ 
      message: 'Solicitud creada exitosamente',
      id_solicitud 
    });

    // Enviar correo de confirmación de recepción (sin esperar)
    const contenidoCorreo = `
      <h2>Solicitud de Entrevista Recibida</h2>
      <p>Estimado/a ${nombre} ${apellidos},</p>
      <p>Hemos recibido tu solicitud de entrevista para:</p>
      <ul>
        <li><strong>Fecha:</strong> ${fecha_cita}</li>
        <li><strong>Hora:</strong> ${hora_cita}</li>
      </ul>
      <p>En breve recibirás una confirmación con los detalles finales de tu entrevista.</p>
      <p>Saludos cordiales,<br>Equipo de Reclutamiento</p>
    `;
    
    enviarCorreo(correo, 'Solicitud de Entrevista Recibida', contenidoCorreo)
      .catch(err => console.error('Error enviando correo de recepción:', err));

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error al crear solicitud:', error);
    res.status(500).json({ error: 'Error al crear la solicitud' });
  } finally {
    client.release();
  }
});

// GET: Obtener todas las solicitudes con información del aspirante y cita
app.get('/api/solicitudes', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        s.id_solicitud,
        s.fecha_solicitud,
        s.estado,
        a.id_aspirante,
        a.nombre,
        a.apellidos,
        a.celular,
        a.correo,
        c.id_cita,
        c.fecha_cita,
        c.hora_cita
      FROM solicitud s
      INNER JOIN aspirante a ON s.id_aspirante = a.id_aspirante
      LEFT JOIN cita c ON c.id_solicitud = s.id_solicitud
      ORDER BY s.fecha_solicitud DESC
    `);
    
    res.json(result.rows);
  } catch (error) {
    console.error('Error al obtener solicitudes:', error);
    res.status(500).json({ error: 'Error al obtener solicitudes' });
  }
});

// PUT: Confirmar cita (actualizar fecha/hora si es necesario)
app.put('/api/solicitudes/:id/confirmar', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { id } = req.params;
    const { fecha_cita, hora_cita } = req.body;

    // Actualizar estado de solicitud
    await client.query(
      'UPDATE solicitud SET estado = $1 WHERE id_solicitud = $2',
      ['confirmada', id]
    );

    // Actualizar fecha y hora de la cita
    await client.query(
      'UPDATE cita SET fecha_cita = $1, hora_cita = $2 WHERE id_solicitud = $3',
      [fecha_cita, hora_cita, id]
    );

    // Obtener datos del aspirante para enviar correo
    const result = await client.query(`
      SELECT a.nombre, a.apellidos, a.correo, c.fecha_cita, c.hora_cita
      FROM solicitud s
      INNER JOIN aspirante a ON s.id_aspirante = a.id_aspirante
      INNER JOIN cita c ON c.id_solicitud = s.id_solicitud
      WHERE s.id_solicitud = $1
    `, [id]);

    const aspirante = result.rows[0];

    await client.query('COMMIT');

    // Responder inmediatamente al cliente
    res.json({ message: 'Cita confirmada exitosamente' });

    // Enviar correo de forma asíncrona (no bloqueante)
    const contenidoCorreo = `
      <h2 style="color: #667eea;">¡Tu Entrevista ha sido Confirmada!</h2>
      <p>Estimado/a ${aspirante.nombre} ${aspirante.apellidos},</p>
      <p>Nos complace confirmar tu entrevista con los siguientes detalles:</p>
      <div style="background: #f8f9fa; padding: 20px; border-radius: 10px; margin: 20px 0;">
        <p style="margin: 10px 0;"><strong>📅 Fecha:</strong> ${new Date(aspirante.fecha_cita).toLocaleDateString('es-MX', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}</p>
        <p style="margin: 10px 0;"><strong>🕐 Hora:</strong> ${aspirante.hora_cita}</p>
      </div>
      <p><strong>Recomendaciones:</strong></p>
      <ul>
        <li>Por favor llega 10 minutos antes</li>
        <li>Trae una copia de tu CV</li>
        <li>Prepara preguntas sobre la posición</li>
      </ul>
      <p>¡Te deseamos mucho éxito en tu entrevista!</p>
      <p>Saludos cordiales,<br><strong>Equipo de Reclutamiento</strong></p>
    `;

    // Enviar correo sin esperar (fire and forget)
    enviarCorreo(
      aspirante.correo,
      '✅ Confirmación de Entrevista',
      contenidoCorreo
    ).catch(err => console.error('Error enviando correo de confirmación:', err));

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error al confirmar cita:', error);
    res.status(500).json({ error: 'Error al confirmar la cita' });
  } finally {
    client.release();
  }
});

// PUT: Rechazar solicitud
app.put('/api/solicitudes/:id/rechazar', async (req, res) => {
  try {
    const { id } = req.params;

    await pool.query(
      'UPDATE solicitud SET estado = $1 WHERE id_solicitud = $2',
      ['rechazada', id]
    );

    res.json({ message: 'Solicitud rechazada' });
  } catch (error) {
    console.error('Error al rechazar solicitud:', error);
    res.status(500).json({ error: 'Error al rechazar solicitud' });
  }
});

// GET: Obtener reclutadores (opcional, para futuras mejoras)
app.get('/api/reclutadores', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM reclutador');
    res.json(result.rows);
  } catch (error) {
    console.error('Error al obtener reclutadores:', error);
    res.status(500).json({ error: 'Error al obtener reclutadores' });
  }
});

// Iniciar servidor
app.listen(PORT, () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
});