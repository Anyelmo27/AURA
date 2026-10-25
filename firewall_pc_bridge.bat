@echo off
:: Ejecutar como Administrador
netsh advfirewall firewall add rule name="NEXO PC Bridge 8766" dir=in action=allow protocol=TCP localport=8766
echo Regla de firewall creada. Si ya existia, ignora el error.
pause