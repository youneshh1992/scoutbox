// One-click reporting + blocking, reachable from EVERY screen via the ⚑
// button in each tab header. Works for both player and guardian sessions.
// An urgent report immediately suspends communication pending review.

import { useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { client } from '../data/client';
import { useSession } from '../state';
import { colors } from '../theme';
import { Button, Card, Muted, Row, SectionTitle } from './ui';

const KNOWN_ORGS = [
  { id: 'org-eastport', name: 'Eastport FC' },
  { id: 'org-harbour', name: 'Harbour City FC' },
  { id: 'org-northstar', name: 'North Star Sports Agency' },
];

export function ReportButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Pressable onPress={() => setOpen(true)} style={styles.flagBtn} accessibilityLabel="Report or block">
        <Text style={{ color: colors.danger, fontSize: 13, fontWeight: '700' }}>⚑ Report</Text>
      </Pressable>
      {open && <ReportSheet onClose={() => setOpen(false)} />}
    </>
  );
}

export function ReportSheet({ onClose }: { onClose: () => void }) {
  const { kind, playerId, guardianId, refresh } = useSession();
  const [targetKind, setTargetKind] = useState<'club' | 'scout'>('club');
  const [orgId, setOrgId] = useState(KNOWN_ORGS[0].id);
  const [scoutName, setScoutName] = useState('');
  const [reason, setReason] = useState('');
  const [urgent, setUrgent] = useState(false);
  const [alsoBlock, setAlsoBlock] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    if (!reason.trim()) return setError('Describe what happened — reports need a reason.');
    const input = {
      targetKind,
      targetOrgId: orgId,
      targetScoutName: targetKind === 'scout' ? scoutName : undefined,
      reason,
      urgent,
    };
    try {
      if (kind === 'guardian' && guardianId) {
        await client.guardianReport(guardianId, input);
        if (alsoBlock) await client.guardianBlock(guardianId, orgId, undefined, reason);
      } else if (playerId) {
        await client.report(playerId, input);
        if (alsoBlock) await client.block(playerId, orgId, reason);
      }
      await refresh();
      setDone(
        urgent
          ? 'Report filed. Communication with this organisation is suspended pending review.'
          : alsoBlock
            ? 'Report filed and organisation blocked.'
            : 'Report filed for review. Thank you for flagging it.'
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not file the report.');
    }
  };

  return (
    <Modal transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.veil}>
        <View style={styles.sheet}>
          <ScrollView contentContainerStyle={{ gap: 10 }}>
            <Row style={{ justifyContent: 'space-between' }}>
              <Text style={styles.title}>Report &amp; block</Text>
              <Button small label="Close" onPress={onClose} />
            </Row>
            {done ? (
              <Card style={{ borderColor: colors.accent }}>
                <Muted size={14}>{done}</Muted>
              </Card>
            ) : (
              <>
                <Muted size={13}>
                  Every report is reviewed. Mark it urgent to suspend all communication with the
                  organisation immediately, pending review.
                </Muted>
                <SectionTitle>What are you reporting?</SectionTitle>
                <Row>
                  <Button small primary={targetKind === 'club'} label="Report Club" onPress={() => setTargetKind('club')} />
                  <Button small primary={targetKind === 'scout'} label="Report Scout" onPress={() => setTargetKind('scout')} />
                </Row>
                <SectionTitle>Organisation</SectionTitle>
                <Row>
                  {KNOWN_ORGS.map((o) => (
                    <Button key={o.id} small primary={orgId === o.id} label={o.name} onPress={() => setOrgId(o.id)} />
                  ))}
                </Row>
                {targetKind === 'scout' && (
                  <TextInput
                    style={styles.input}
                    placeholder="Scout name (as shown on the request)"
                    placeholderTextColor={colors.muted}
                    value={scoutName}
                    onChangeText={setScoutName}
                  />
                )}
                <SectionTitle>What happened?</SectionTitle>
                <TextInput
                  style={styles.input}
                  placeholder="Describe the behaviour"
                  placeholderTextColor={colors.muted}
                  value={reason}
                  onChangeText={setReason}
                  multiline
                />
                <Row style={{ justifyContent: 'space-between' }}>
                  <Muted size={13}>Urgent — suspend communication now</Muted>
                  <Switch value={urgent} onValueChange={setUrgent} trackColor={{ true: colors.danger, false: colors.line }} thumbColor="#fff" />
                </Row>
                <Row style={{ justifyContent: 'space-between' }}>
                  <Muted size={13}>Also block this organisation</Muted>
                  <Switch value={alsoBlock} onValueChange={setAlsoBlock} trackColor={{ true: colors.danger, false: colors.line }} thumbColor="#fff" />
                </Row>
                {error && (
                  <Card style={{ borderColor: colors.danger }}>
                    <Text style={{ color: colors.danger, fontSize: 13 }}>{error}</Text>
                  </Card>
                )}
                <Button primary label="Submit report" onPress={submit} />
              </>
            )}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  flagBtn: {
    borderWidth: 1,
    borderColor: colors.danger,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 5,
  },
  veil: { flex: 1, backgroundColor: 'rgba(3,8,18,0.7)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: colors.bg2,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    borderWidth: 1,
    borderColor: colors.line,
    padding: 18,
    maxHeight: '85%',
  },
  title: { color: colors.text, fontSize: 20, fontWeight: '800' },
  input: {
    backgroundColor: colors.bg,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: 10,
    color: colors.text,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 15,
  },
});
