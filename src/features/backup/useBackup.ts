import { useQueryClient } from '@tanstack/react-query';
import type { RefObject } from 'react';
import { useEffect,useRef,useState,type ChangeEvent } from 'react';
import { type ProviderSettings } from '../../../shared/providers/types';
import { api } from '../../platform/api';
import { storageEpoch } from '../../platform/storage';

import { createArchive,restoreArchive,type BackupProgress } from '../backup/archive-client';
import { downloadFile } from '../backup/download';


export function useBackup({ selected, selectedRef, setError, providerSaved, refreshLibrary, navigate }: {
  selected: string | null; selectedRef: RefObject<string | null>; setError: (error: string) => void; providerSaved: (settings: ProviderSettings) => void; refreshLibrary: () => void; navigate: (id: string) => void;
}) {
  const queryClient = useQueryClient();
  const backupOperation = useRef<AbortController | null>(null);
  const [backupTask, setBackupTask] = useState<{ title: string; progress: BackupProgress; route: string | null; epoch: number } | null>(null);
  useEffect(() => () => backupOperation.current?.abort(), []);
  const exportBackup = async () => {
    if (!selected || backupOperation.current) return;
    const controller = new AbortController(), id = selected, epoch = storageEpoch(); backupOperation.current = controller;
    setBackupTask({ title: '下载备份', progress: { value: 0, label: '正在读取备份资料' }, route: id, epoch });
    try {
      const blob = await createArchive(id, controller.signal, (progress) => setBackupTask((task) => task ? { ...task, progress } : null));
      if (!controller.signal.aborted && epoch === storageEpoch()) downloadFile(`EverChat-${id}.everchat.zip`, blob, 'application/zip');
    } catch (cause) { if (!controller.signal.aborted && epoch === storageEpoch()) setError(cause instanceof Error ? cause.message : '备份失败，请稍后重试。'); }
    finally { if (backupOperation.current === controller) { backupOperation.current = null; setBackupTask(null); } }
  };
  const importBackup = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]; event.target.value = '';
    if (!file || backupOperation.current) return;
    const controller = new AbortController(), sourceId = selectedRef.current, epoch = storageEpoch(); backupOperation.current = controller;
    setError('');
    setBackupTask({ title: '导入备份', progress: { value: 0, label: '正在检查备份' }, route: sourceId, epoch });
    try {
      const result = await restoreArchive(file, controller.signal, (progress) => setBackupTask((task) => task ? { ...task, progress } : null));
      if (epoch !== storageEpoch() || controller.signal.aborted) return;
      void queryClient.invalidateQueries({ queryKey: ['provider-settings'] });
      void api<ProviderSettings>('/settings/providers').then((config) => { if (epoch === storageEpoch()) providerSaved(config); }).catch(() => {});
      refreshLibrary(); if (selectedRef.current === sourceId) navigate(result.id);
    } catch (cause) { if (!controller.signal.aborted && epoch === storageEpoch()) setError(cause instanceof Error ? cause.message : '恢复备份失败，请检查文件。'); }
    finally { if (backupOperation.current === controller) { backupOperation.current = null; setBackupTask(null); } }
  };
  return { backupOperation, backupTask, exportBackup, importBackup, cancelBackup: () => { backupOperation.current?.abort(); setBackupTask(null); } };
}
