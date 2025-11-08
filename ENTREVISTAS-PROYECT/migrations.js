const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

async function runMigrations() {
  const client = await pool.connect();
  
  try {
    console.log('🚀 Iniciando migraciones de base de datos...');

    // Verificar si las tablas ya existen
    const tablesExist = await client.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = 'aspirante'
      );
    `);

    if (tablesExist.rows[0].exists) {
      console.log('✅ Las tablas ya existen. Saltando migración.');
      return;
    }

    console.log('📝 Creando tablas...');

    // Crear tabla aspirante
    await client.query(`
      CREATE TABLE IF NOT EXISTS aspirante (
        id_aspirante SERIAL PRIMARY KEY,
        nombre VARCHAR(100) NOT NULL,
        apellidos VARCHAR(100) NOT NULL,
        celular VARCHAR(15) NOT NULL,
        correo VARCHAR(100) NOT NULL UNIQUE,
        fecha_registro TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('✓ Tabla aspirante creada');

    // Crear tabla reclutador
    await client.query(`
      CREATE TABLE IF NOT EXISTS reclutador (
        id_reclutador SERIAL PRIMARY KEY,
        nombre VARCHAR(100) NOT NULL,
        correo VARCHAR(100) NOT NULL UNIQUE,
        fecha_registro TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('✓ Tabla reclutador creada');

    // Crear tabla solicitud
    await client.query(`
      CREATE TABLE IF NOT EXISTS solicitud (
        id_solicitud SERIAL PRIMARY KEY,
        fecha_solicitud TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        estado VARCHAR(20) NOT NULL CHECK (estado IN ('pendiente', 'confirmada', 'rechazada', 'cancelada')),
        id_aspirante INTEGER NOT NULL,
        FOREIGN KEY (id_aspirante) REFERENCES aspirante(id_aspirante) ON DELETE CASCADE
      );
    `);
    console.log('✓ Tabla solicitud creada');

    // Crear tabla cita
    await client.query(`
      CREATE TABLE IF NOT EXISTS cita (
        id_cita SERIAL PRIMARY KEY,
        fecha_cita DATE NOT NULL,
        hora_cita TIME NOT NULL,
        id_solicitud INTEGER NOT NULL UNIQUE,
        id_reclutador INTEGER,
        FOREIGN KEY (id_solicitud) REFERENCES solicitud(id_solicitud) ON DELETE CASCADE,
        FOREIGN KEY (id_reclutador) REFERENCES reclutador(id_reclutador) ON DELETE SET NULL
      );
    `);
    console.log('✓ Tabla cita creada');

    // Crear índices
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_solicitud_estado ON solicitud(estado);
      CREATE INDEX IF NOT EXISTS idx_solicitud_aspirante ON solicitud(id_aspirante);
      CREATE INDEX IF NOT EXISTS idx_cita_fecha ON cita(fecha_cita);
      CREATE INDEX IF NOT EXISTS idx_aspirante_correo ON aspirante(correo);
    `);
    console.log('✓ Índices creados');

    // Crear vista
    await client.query(`
      CREATE OR REPLACE VIEW vista_solicitudes_completas AS
      SELECT 
        s.id_solicitud,
        s.fecha_solicitud,
        s.estado,
        a.id_aspirante,
        a.nombre AS aspirante_nombre,
        a.apellidos AS aspirante_apellidos,
        a.celular AS aspirante_celular,
        a.correo AS aspirante_correo,
        c.id_cita,
        c.fecha_cita,
        c.hora_cita,
        r.nombre AS reclutador_nombre
      FROM solicitud s
      INNER JOIN aspirante a ON s.id_aspirante = a.id_aspirante
      LEFT JOIN cita c ON c.id_solicitud = s.id_solicitud
      LEFT JOIN reclutador r ON c.id_reclutador = r.id_reclutador;
    `);
    console.log('✓ Vista creada');

    // Crear función de verificación de disponibilidad
    await client.query(`
      CREATE OR REPLACE FUNCTION verificar_disponibilidad(
        p_fecha DATE,
        p_hora TIME
      ) RETURNS BOOLEAN AS $$
      DECLARE
        v_count INTEGER;
      BEGIN
        SELECT COUNT(*)
        INTO v_count
        FROM cita c
        INNER JOIN solicitud s ON c.id_solicitud = s.id_solicitud
        WHERE c.fecha_cita = p_fecha
        AND c.hora_cita = p_hora
        AND s.estado = 'confirmada';
        
        RETURN v_count = 0;
      END;
      $$ LANGUAGE plpgsql;
    `);
    console.log('✓ Función creada');

    // Insertar reclutador de ejemplo si no existe
    const reclutadorExists = await client.query(`
      SELECT COUNT(*) FROM reclutador;
    `);

    if (parseInt(reclutadorExists.rows[0].count) === 0) {
      await client.query(`
        INSERT INTO reclutador (nombre, correo) 
        VALUES ('Reclutador Principal', 'reclutador@empresa.com');
      `);
      console.log('✓ Reclutador de ejemplo insertado');
    }

    console.log('✅ Migraciones completadas exitosamente!');

  } catch (error) {
    console.error('❌ Error en migraciones:', error);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

// Ejecutar migraciones si se llama directamente
if (require.main === module) {
  runMigrations()
    .then(() => {
      console.log('✨ Base de datos lista para usar');
      process.exit(0);
    })
    .catch((error) => {
      console.error('💥 Error fatal:', error);
      process.exit(1);
    });
}

module.exports = { runMigrations };