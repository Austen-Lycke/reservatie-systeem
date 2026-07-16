# Reserveringssysteem

Webapp waarmee bezoekers via een kalender een datum reserveren voor een privéfeest
en meteen online de reservatiekosten betalen.

## Hoe het werkt

1. De bezoeker kiest in de kalender een vrije (groene) datum en vult het
   reserveringsformulier in.
2. De datum staat vervolgens 30 minuten vast (geel) terwijl de bezoeker afrekent
   op de beveiligde betaalpagina van Mollie.
3. Betaling geslaagd → de datum wordt definitief bezet (rood), voor iedereen
   direct zichtbaar. Niet betaald → de datum komt vanzelf weer vrij.

Er is maximaal 1 feest per dag mogelijk; dubbele boekingen zijn technisch
onmogelijk. Bezoekers zien alleen welke dagen bezet zijn — nooit wie er geboekt
heeft.
