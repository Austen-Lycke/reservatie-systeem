// Edge function "mollie-webhook": wordt door Mollie aangeroepen zodra de
// status van een betaling verandert. Bevestigt de reservering (rood) bij
// een geslaagde betaling, of geeft de datum weer vrij als de betaling is
// afgebroken, mislukt of verlopen.
//
// Belangrijk: deze functie moet bereikbaar zijn ZONDER Supabase-JWT
// (verify_jwt = false), anders kan Mollie hem niet aanroepen.
import { createClient } from 'npm:@supabase/supabase-js@2';

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('ok');

  const mollieSleutel = Deno.env.get('MOLLIE_API_KEY');
  if (!mollieSleutel) return new Response('MOLLIE_API_KEY ontbreekt', { status: 500 });

  // Mollie stuurt alleen een betalings-id; de echte status vragen we altijd
  // zelf bij Mollie op, zodat niemand met een nep-webhook een reservering
  // kan bevestigen.
  let betalingId = '';
  try {
    const form = await req.formData();
    betalingId = String(form.get('id') ?? '');
  } catch {
    // geen geldig formulier
  }
  if (!betalingId) return new Response('geen id', { status: 400 });

  const mollieAntwoord = await fetch(`https://api.mollie.com/v2/payments/${betalingId}`, {
    headers: { 'Authorization': `Bearer ${mollieSleutel}` }
  });
  if (mollieAntwoord.status === 404) return new Response('onbekende betaling');
  if (!mollieAntwoord.ok) {
    // Tijdelijk probleem bij Mollie: met een 5xx-antwoord probeert Mollie
    // de webhook later automatisch opnieuw.
    return new Response('Mollie tijdelijk niet bereikbaar', { status: 502 });
  }

  const betaling = await mollieAntwoord.json();
  const datum: string | undefined = betaling.metadata?.datum;
  if (!datum) return new Response('ok');

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  );

  if (betaling.status === 'paid') {
    // Controleer dat deze betaling nog steeds bij de huidige reservering op
    // deze datum hoort. In het zeldzame geval dat de klant pas ná de
    // wachttijd van 30 minuten betaalde én iemand anders de datum intussen
    // opnieuw boekte, hoort het geld terug naar de trage betaler.
    const { data: details } = await admin.from('reservering_details')
      .select('mollie_betaling_id')
      .eq('datum', datum)
      .maybeSingle();

    if (!details || details.mollie_betaling_id !== betalingId) {
      console.error(`Betaling ${betalingId} hoort niet (meer) bij ${datum}; terugbetaling gestart.`);
      const terugbetaling = await fetch(`https://api.mollie.com/v2/payments/${betalingId}/refunds`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${mollieSleutel}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          amount: betaling.amount,
          description: `Datum ${datum} was intussen bezet`
        })
      });
      if (!terugbetaling.ok) {
        console.error('Automatische terugbetaling mislukt; handel af via het Mollie-dashboard:',
          await terugbetaling.text().catch(() => '?'));
      }
      return new Response('ok');
    }

    await admin.from('reserveringen')
      .update({ status: 'betaald', verloopt_op: null })
      .eq('datum', datum)
      .eq('status', 'in_afwachting');
  } else if (['expired', 'canceled', 'failed'].includes(betaling.status)) {
    // Betaling gaat definitief niet door: datum weer vrijgeven (groen).
    await admin.from('reserveringen')
      .delete()
      .eq('datum', datum)
      .eq('status', 'in_afwachting');
  }
  // Andere statussen ('open', 'pending', ...) zijn tussenstappen: niets doen.

  return new Response('ok');
});
