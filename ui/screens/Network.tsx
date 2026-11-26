import { useEffect, useState } from 'react';
import { api, errorText, type NetworkStatus, type Person } from '../api';
import { Devices, OfflineRule, Pairing, PhotosOnDemand, SyncNow } from './NetworkDevices';
import { HostBackups, LeaveVault, MoveHostHere, StartHosting, StopHosting } from './NetworkHost';

/** The vault on this network. For an admin, serving it to other computers
 * (docs/adr/0022-host-mode.md): starting, pairing computers, the computers paired, and stopping.
 * For anyone on a computer that syncs with a host (docs/adr/0023-client-mode.md): syncing, and
 * leaving the vault. */
export function Network({
  people,
  admin,
  phone = false,
  onChanged,
  onLeft
}: {
  people: Person[];
  admin: boolean;
  /** A phone or tablet never serves the vault (ADR 27). */
  phone?: boolean;
  onChanged: () => void;
  onLeft: () => void;
}) {
  const [status, setStatus] = useState<NetworkStatus | null>(null);
  const [error, setError] = useState('');
  const load = () =>
    api
      .networkStatus()
      .then(setStatus)
      .catch((e) => setError(errorText(e)));
  useEffect(() => {
    void load();
  }, []);

  if (!status) return error ? <p className="error">{error}</p> : <p className="hint">Loading…</p>;
  if (!status.replica && phone)
    return (
      <p className="hint">
        This vault is on this phone alone. A phone cannot serve a vault to other computers: to share it on your
        network, restore a backup of it on a computer and serve it from there.
      </p>
    );
  if (!status.replica && !admin)
    return <p className="hint">This vault is on this computer alone. An admin can serve it to the team's other computers.</p>;
  if (!status.replica)
    return (
      <StartHosting
        status={status}
        onStarted={() => {
          void load();
          onChanged();
        }}
      />
    );
  return (
    <>
      <p>
        {status.hostHere && status.hostRetired
          ? 'This computer no longer serves the vault: the host moves to another computer. To go on working here, leave this vault, then join the host where it is now with a code from an admin.'
          : status.hostHere
            ? `This computer serves the vault on this network, on port ${status.hostAddress?.split(':')[1]}. It needs to stay on for other computers to sync.`
            : `This vault syncs with the host at ${status.hostAddress}.`}
      </p>
      <SyncNow onPulled={onChanged} />
      {!status.hostHere && <PhotosOnDemand />}
      {admin && <Pairing people={people} />}
      {admin && <Devices people={people} own={status.device} />}
      {admin && <OfflineRule />}
      {admin && <HostBackups />}
      {status.hostHere ? (
        <>
          {admin && !status.hostRetired && (
            <StopHosting
              movedHere={status.hostMovedHere}
              onStopped={() => {
                void load();
                onChanged();
              }}
            />
          )}
          <LeaveVault onLeft={onLeft} servedHere />
        </>
      ) : (
        <>
          {admin && status.canHost && (
            <MoveHostHere
              status={status}
              onMoved={() => {
                void load();
                onChanged();
              }}
            />
          )}
          <LeaveVault onLeft={onLeft} />
        </>
      )}
    </>
  );
}
